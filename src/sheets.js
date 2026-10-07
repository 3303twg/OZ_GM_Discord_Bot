import fs from "node:fs";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import { formatSeoulNow, seoulDayKey } from "./format.js";
import { pickPerson } from "./match.js";

const LOG_HEADERS = [
  "작성시각",
  "보고유형",
  "디스코드닉네임",
  "역할",
  "내용",
  "메시지링크",
  "보고일자",
  "불참날짜",
  "대체업무 진행날짜",
];
const ABSENCE_SHEET_TITLE = "업무불참";
const ABSENCE_HEADERS = [
  "작성시각",
  "이름",
  "역할",
  "불참날짜",
  "대체업무 진행날짜",
  "불참사유",
  "메시지링크",
];
const DASHBOARD_HEADERS = [
  "직무",
  "이름",
  "현재 상태",
  "출근시간",
  "퇴근시간",
  "판정 시각",
  "정정 여부",
  "불참 여부",
];
const ABSENT = "미출근";
const FLUSH_WINDOW_MS = 60_000;
const FLUSH_RETRY_MS = 60_000;
const ROSTER_REFRESH_MS = 5 * 60_000;
const statePath = path.resolve("data/dashboard-day.json");
const pendingPath = path.resolve("data/pending-writes.json");
const FIRST_ROSTER_ROLES = new Map([
  ["교육자료 리뷰어", "리뷰어"],
  ["러닝헬퍼(단기 조교)", "러닝헬퍼"],
]);
const THIRD_ROSTER_JOB = "디자이너 러닝헬퍼";

export function secondRosterJob(track) {
  const value = String(track ?? "").replace(/\s+/g, "");
  if (value === "디자이너") {
    return THIRD_ROSTER_JOB;
  }
  if (value === "개발자") {
    return "수습 연구원";
  }
  return String(track ?? "").trim();
}

export function rosterDataRows(values, nameIndex, statusIndex) {
  const headerIndex = values.findIndex((row) => String(row[nameIndex] ?? "").replace(/\s+/g, "").includes("이름"));
  if (headerIndex >= 0) {
    return values.slice(headerIndex + 1);
  }
  const firstStatus = String(values[0]?.[statusIndex] ?? "").replace(/\s+/g, "");
  return firstStatus === "근무중" ? values : values.slice(1);
}

export function applyPeoplePatch(people, nickname, patch) {
  const picked = pickPerson(nickname, people);
  if (picked.status !== "found") {
    return { status: picked.status, people };
  }
  return {
    status: "updated",
    people: people.map((person, index) => (index === picked.index ? { ...person, ...patch } : person)),
  };
}

export function mergeDashboard(roster, current, { resetTimes, absentNames, now }) {
  return roster.map((person) => {
    const existing = current.find((row) => row.name === person.name);
    if (!existing || resetTimes) {
      const isAbsent = absentNames.has(person.name.toLowerCase());
      return {
        job: person.job,
        name: person.name,
        status: isAbsent ? "불참" : ABSENT,
        clockIn: "-",
        clockOut: "-",
        judgedAt: isAbsent ? now : "-",
        corrected: false,
        absent: isAbsent,
      };
    }
    if (absentNames.has(person.name.toLowerCase())) {
      return {
        ...existing,
        job: person.job || existing.job,
        name: person.name,
        status: "불참",
        judgedAt: existing.status === "불참" ? existing.judgedAt : now,
        absent: true,
      };
    }
    return { ...existing, job: person.job || existing.job, name: person.name };
  });
}

export function createWorkbook(config) {
  const auth = new GoogleAuth({
    keyFile: config.serviceAccountPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const titles = new Map();
  const namedTitles = new Set();
  const readyHeaders = new Set();
  let chain = Promise.resolve();
  let dashboardCache = [];
  let todayAbsenceNames = new Set();
  let absenceScheduleLoaded = false;
  let dashboardReady = false;
  let dashboardValidationReady = false;
  let lastDashboardSize = null;
  let rosterDirty = false;
  let flushTimer = null;
  const pending = { logs: [], absences: [], patches: [] };

  loadPending();

  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  function loadPending() {
    if (!fs.existsSync(pendingPath)) {
      return;
    }
    try {
      const saved = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
      pending.logs = Array.isArray(saved.logs) ? saved.logs : [];
      pending.absences = Array.isArray(saved.absences) ? saved.absences : [];
      pending.patches = Array.isArray(saved.patches) ? saved.patches : [];
    } catch (error) {
      console.error("모아 둔 시트 기록을 읽지 못했습니다.", error);
    }
  }

  function persistPending() {
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(
      pendingPath,
      JSON.stringify(
        {
          logs: pending.logs,
          absences: pending.absences,
          patches: pending.patches,
        },
        null,
        2,
      ),
    );
  }

  function hasSheetWork() {
    return pending.logs.length > 0 || pending.absences.length > 0 || pending.patches.length > 0 || rosterDirty;
  }

  function armFlush(delayMs) {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      enqueue(() => runFlush()).catch((error) => {
        console.error("시트 일괄 기록 실패", error);
        armFlush(FLUSH_RETRY_MS);
      });
    }, delayMs);
    flushTimer.unref?.();
  }

  function rememberPendingAbsences(targetDate) {
    for (const row of pending.absences) {
      const name = String(row[1] ?? "").trim().toLowerCase();
      if (name && String(row[3] ?? "").trim() === targetDate) {
        todayAbsenceNames.add(name);
      }
    }
  }

  function applyToCache(nickname, patch) {
    const result = applyPeoplePatch(dashboardCache, nickname, patch);
    if (result.status === "updated") {
      dashboardCache = result.people;
    }
    return result.status;
  }

  function replayPatches(people) {
    let current = people;
    for (const item of pending.patches) {
      const result = applyPeoplePatch(current, item.nickname, item.patch);
      if (result.status === "updated") {
        current = result.people;
      } else {
        console.warn(`대시보드 닉네임 반영 안 됨: ${item.nickname} (${result.status})`);
      }
    }
    return current;
  }

  async function request(spreadsheetId, suffix, options = {}) {
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${suffix}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
        "Content-Type": "application/json",
      },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(body?.error?.message ?? `구글 시트 요청 실패 (${response.status})`);
    }
    return body;
  }

  function rangeOf(title, a1) {
    return encodeURIComponent(`'${title.replaceAll("'", "''")}'!${a1}`);
  }

  async function sheetTitle(spreadsheetId, sheetId) {
    const key = `${spreadsheetId}:${sheetId}`;
    if (titles.has(key)) {
      return titles.get(key);
    }
    const metadata = await request(spreadsheetId, "?fields=sheets.properties");
    const sheet = metadata.sheets?.find((item) => item.properties.sheetId === sheetId);
    if (!sheet) {
      throw new Error(`시트 gid ${sheetId}를 찾지 못했습니다.`);
    }
    titles.set(key, sheet.properties.title);
    return sheet.properties.title;
  }

  async function ensureSheetByTitle(spreadsheetId, title) {
    const key = `${spreadsheetId}:${title}`;
    if (namedTitles.has(key)) {
      return title;
    }
    const metadata = await request(spreadsheetId, "?fields=sheets.properties.title");
    const exists = metadata.sheets?.some((sheet) => sheet.properties.title === title);
    if (!exists) {
      await request(spreadsheetId, ":batchUpdate", {
        method: "POST",
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title } } }],
        }),
      });
    }
    namedTitles.add(key);
    return title;
  }

  async function readValues(spreadsheetId, title, a1) {
    const body = await request(spreadsheetId, `/values/${rangeOf(title, a1)}`);
    return body.values ?? [];
  }

  async function writeValues(spreadsheetId, title, a1, values) {
    await request(spreadsheetId, `/values/${rangeOf(title, a1)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values }),
    });
  }

  async function clearValues(spreadsheetId, title, a1) {
    await request(spreadsheetId, `/values/${rangeOf(title, a1)}:clear`, { method: "POST", body: "{}" });
  }

  async function ensureHeader(spreadsheetId, title, headers, a1, headerKey) {
    if (readyHeaders.has(headerKey)) {
      return;
    }
    const rows = await readValues(spreadsheetId, title, a1);
    const current = rows[0] ?? [];
    const matches = headers.every((header, index) => current[index] === header);
    if (!matches) {
      await writeValues(spreadsheetId, title, a1, [headers]);
    }
    readyHeaders.add(headerKey);
  }

  async function ensureDashboardCheckboxes() {
    if (dashboardValidationReady) {
      return;
    }
    await request(config.spreadsheetId, ":batchUpdate", {
      method: "POST",
      body: JSON.stringify({
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: config.dashboardSheetId,
                startRowIndex: 1,
                startColumnIndex: 6,
                endColumnIndex: 8,
              },
              cell: {
                dataValidation: {
                  condition: { type: "BOOLEAN" },
                  strict: true,
                  showCustomUi: true,
                },
              },
              fields: "dataValidation",
            },
          },
        ],
      }),
    });
    dashboardValidationReady = true;
  }

  function readDay() {
    if (!fs.existsSync(statePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(statePath, "utf8")).date ?? null;
  }

  function writeDay(date) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ date }, null, 2));
  }

  function rosterPeople(values, nameIndex, statusIndex, roleOf) {
    if (!values.length) {
      return [];
    }
    return rosterDataRows(values, nameIndex, statusIndex)
      .map((row) => ({
        job: roleOf(row),
        name: String(row[nameIndex] ?? "").trim(),
        employment: String(row[statusIndex] ?? "").replace(/\s+/g, ""),
      }))
      .filter((person) => person.name && person.employment === "근무중");
  }

  function mergeRosterPeople(...groups) {
    const people = new Map();
    for (const person of groups.flat()) {
      const existing = people.get(person.name);
      if (!existing) {
        people.set(person.name, person);
      } else if (!existing.job && person.job) {
        people.set(person.name, { ...existing, job: person.job });
      }
    }
    return [...people.values()];
  }

  function dashboardRows(values) {
    return values
      .slice(1)
      .map((row) => ({
        job: String(row[0] ?? "").trim(),
        name: String(row[1] ?? "").trim(),
        status: String(row[2] ?? "").trim() || ABSENT,
        clockIn: String(row[3] ?? "").trim() || "-",
        clockOut: String(row[4] ?? "").trim() || "-",
        judgedAt: String(row[5] ?? "").trim() || "-",
        corrected: row[6] === true || String(row[6] ?? "").toUpperCase() === "TRUE",
        absent: row[7] === true || String(row[7] ?? "").toUpperCase() === "TRUE",
      }))
      .filter((person) => person.name);
  }

  function toCells(person) {
    return [
      person.job,
      person.name,
      person.status,
      person.clockIn,
      person.clockOut,
      person.judgedAt,
      Boolean(person.corrected),
      Boolean(person.absent),
    ];
  }

  function clonePeople(people) {
    return people.map((person) => ({ ...person }));
  }

  async function readDashboardSheet() {
    const dashboardTitle = await sheetTitle(config.spreadsheetId, config.dashboardSheetId);
    await ensureHeader(config.spreadsheetId, dashboardTitle, DASHBOARD_HEADERS, "A1:H1", "dashboard");
    return dashboardRows(await readValues(config.spreadsheetId, dashboardTitle, "A:H"));
  }

  async function loadRoster() {
    const firstRosterTitle = await sheetTitle(config.rosterSpreadsheetId, config.rosterSheetId);
    const secondRosterTitle = await sheetTitle(config.rosterSpreadsheetId, config.secondRosterSheetId);
    const thirdRosterTitle = await sheetTitle(config.thirdRosterSpreadsheetId, config.thirdRosterSheetId);
    const [firstValues, secondValues, thirdValues] = await Promise.all([
      readValues(config.rosterSpreadsheetId, firstRosterTitle, "A:L"),
      readValues(config.rosterSpreadsheetId, secondRosterTitle, "A:L"),
      readValues(config.thirdRosterSpreadsheetId, thirdRosterTitle, "A:N"),
    ]);
    return mergeRosterPeople(
      rosterPeople(firstValues, 1, 11, (row) => {
        const sourceRole = String(row[3] ?? "").trim();
        return FIRST_ROSTER_ROLES.get(sourceRole) ?? sourceRole;
      }),
      rosterPeople(secondValues, 2, 11, (row) => secondRosterJob(row[9])),
      rosterPeople(thirdValues, 1, 13, () => THIRD_ROSTER_JOB),
    );
  }

  async function writeDashboard(people) {
    const dashboardTitle = await sheetTitle(config.spreadsheetId, config.dashboardSheetId);
    await ensureHeader(config.spreadsheetId, dashboardTitle, DASHBOARD_HEADERS, "A1:H1", "dashboard");
    await writeValues(config.spreadsheetId, dashboardTitle, `A1:H${Math.max(people.length + 1, 1)}`, [
      DASHBOARD_HEADERS,
      ...people.map(toCells),
    ]);
    await ensureDashboardCheckboxes();
    if (lastDashboardSize === null || people.length < lastDashboardSize) {
      await clearValues(config.spreadsheetId, dashboardTitle, `A${people.length + 2}:H1000`);
    }
    lastDashboardSize = people.length;
  }

  async function syncRoster(resetTimes, { write }) {
    const roster = await loadRoster();
    const current = dashboardCache.length > 0 ? dashboardCache : await readDashboardSheet();
    const before = JSON.stringify(dashboardCache);
    dashboardCache = replayPatches(
      mergeDashboard(roster, current, {
        resetTimes,
        absentNames: todayAbsenceNames,
        now: formatSeoulNow(),
      }),
    );
    if (JSON.stringify(dashboardCache) !== before) {
      rosterDirty = true;
    }
    if (write) {
      await writeDashboard(clonePeople(dashboardCache));
      if (pending.patches.length === 0) {
        rosterDirty = false;
      }
    }
  }

  async function appendRows(title, headerKey, headers, headerRange, columns, rows) {
    await ensureHeader(config.spreadsheetId, title, headers, headerRange, headerKey);
    await request(
      config.spreadsheetId,
      `/values/${rangeOf(title, columns)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: rows }) },
    );
  }

  async function writeQueuedLogs() {
    const rows = pending.logs.slice();
    if (!rows.length) {
      return 0;
    }
    const title = await sheetTitle(config.spreadsheetId, config.logSheetId);
    await appendRows(title, "log", LOG_HEADERS, "A1:I1", "A:I", rows);
    pending.logs.splice(0, rows.length);
    persistPending();
    return rows.length;
  }

  async function writeQueuedAbsences() {
    const rows = pending.absences.slice();
    if (!rows.length) {
      return 0;
    }
    const title = await ensureSheetByTitle(config.spreadsheetId, ABSENCE_SHEET_TITLE);
    await appendRows(title, "absence", ABSENCE_HEADERS, "A1:G1", "A:G", rows);
    pending.absences.splice(0, rows.length);
    persistPending();
    return rows.length;
  }

  async function writeQueuedDashboard() {
    if (pending.patches.length === 0 && !rosterDirty) {
      return false;
    }
    if (dashboardCache.length === 0) {
      throw new Error("대시보드 명단을 불러오기 전에 출근부를 저장할 수 없습니다.");
    }
    const patchCount = pending.patches.length;
    await writeDashboard(clonePeople(dashboardCache));
    pending.patches.splice(0, patchCount);
    if (pending.patches.length === 0) {
      rosterDirty = false;
    }
    persistPending();
    return true;
  }

  async function flushPending() {
    if (!hasSheetWork()) {
      return { ok: true, logCount: 0, absenceCount: 0, dashboardWritten: false };
    }
    let logCount = 0;
    let absenceCount = 0;
    let dashboardWritten = false;
    try {
      logCount = await writeQueuedLogs();
      absenceCount = await writeQueuedAbsences();
      dashboardWritten = await writeQueuedDashboard();
    } catch (error) {
      console.error("시트 일괄 기록 실패", error);
      return { ok: false, logCount, absenceCount, dashboardWritten };
    }
    const parts = [`로그 ${logCount}건`, `불참 ${absenceCount}건`];
    if (dashboardWritten) {
      parts.push("대시보드 갱신");
    }
    console.log(`시트 일괄 기록: ${parts.join(", ")}`);
    return { ok: true, logCount, absenceCount, dashboardWritten };
  }

  async function runFlush() {
    const result = await flushPending();
    if (!result.ok) {
      armFlush(FLUSH_RETRY_MS);
      return;
    }
    if (hasSheetWork()) {
      armFlush(FLUSH_WINDOW_MS);
    }
  }

  async function refreshAbsenceSchedule(targetDate) {
    const title = await ensureSheetByTitle(config.spreadsheetId, ABSENCE_SHEET_TITLE);
    await ensureHeader(config.spreadsheetId, title, ABSENCE_HEADERS, "A1:G1", "absence");
    const rows = await readValues(config.spreadsheetId, title, "A:G");
    const entries = rows.slice(1);
    const active = entries.filter((row) => {
      const absenceDate = String(row[3] ?? "").trim();
      return !absenceDate || absenceDate >= targetDate;
    });

    if (active.length !== entries.length) {
      await writeValues(config.spreadsheetId, title, `A1:G${active.length + 1}`, [ABSENCE_HEADERS, ...active]);
      await clearValues(config.spreadsheetId, title, `A${active.length + 2}:G${entries.length + 1}`);
    }

    todayAbsenceNames = new Set(
      active
        .filter((row) => String(row[3] ?? "").trim() === targetDate)
        .map((row) => String(row[1] ?? "").trim().toLowerCase())
        .filter(Boolean),
    );
    rememberPendingAbsences(targetDate);
    absenceScheduleLoaded = true;
  }

  async function publishCachedDashboard() {
    if (hasSheetWork()) {
      if (!((await flushPending()).ok)) {
        armFlush(FLUSH_RETRY_MS);
        return;
      }
      if (hasSheetWork()) {
        armFlush(FLUSH_WINDOW_MS);
      }
      return;
    }
    if (!rosterDirty) {
      return;
    }
    try {
      await writeDashboard(clonePeople(dashboardCache));
      rosterDirty = false;
    } catch (error) {
      console.error("대시보드 명단 갱신 실패", error);
      armFlush(FLUSH_RETRY_MS);
    }
  }

  async function catchUpDay() {
    const today = seoulDayKey();
    const saved = readDay();
    const todayLabel = today.replaceAll("-", ".");
    const loadedNow = !dashboardReady;
    if (loadedNow) {
      if (saved !== null && saved !== today) {
        dashboardCache = replayPatches(await readDashboardSheet());
        if (dashboardCache.length === 0) {
          if (!absenceScheduleLoaded) {
            await refreshAbsenceSchedule(todayLabel);
          }
          await syncRoster(false, { write: false });
        }
        rosterDirty =
          rosterDirty || pending.logs.length > 0 || pending.absences.length > 0 || pending.patches.length > 0;
      } else {
        if (!absenceScheduleLoaded) {
          await refreshAbsenceSchedule(todayLabel);
        }
        await syncRoster(false, { write: false });
      }
      dashboardReady = true;
    }

    if (saved !== null && saved !== today) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (hasSheetWork() && !((await flushPending()).ok)) {
        console.error("모아 둔 시트 기록을 마치지 못해 자정 초기화를 미뤘습니다.");
        armFlush(FLUSH_RETRY_MS);
        return;
      }
      await refreshAbsenceSchedule(todayLabel);
      await syncRoster(true, { write: true });
      writeDay(today);
      console.log("자정이 지나 출근·퇴근 시각을 비웠습니다.");
      if (hasSheetWork() && !((await flushPending()).ok)) {
        armFlush(FLUSH_RETRY_MS);
      } else if (hasSheetWork()) {
        armFlush(FLUSH_WINDOW_MS);
      }
      return;
    }

    if (loadedNow) {
      await publishCachedDashboard();
      if (saved !== today) {
        writeDay(today);
        console.log("대시보드 명단을 채웠습니다.");
      }
    }
  }

  async function refreshRoster() {
    if (!dashboardReady) {
      return;
    }
    await refreshAbsenceSchedule(seoulDayKey().replaceAll("-", "."));
    await syncRoster(false, { write: false });
    if (!rosterDirty) {
      return;
    }
    if (flushTimer || pending.logs.length > 0 || pending.absences.length > 0 || pending.patches.length > 0) {
      armFlush(FLUSH_WINDOW_MS);
      return;
    }
    try {
      await writeDashboard(clonePeople(dashboardCache));
      rosterDirty = false;
    } catch (error) {
      console.error("대시보드 명단 갱신 실패", error);
      armFlush(FLUSH_RETRY_MS);
    }
  }

  return {
    isDashboardReady() {
      return dashboardReady;
    },
    roleForNickname(nickname) {
      const picked = pickPerson(nickname, dashboardCache);
      return picked.status === "found" ? dashboardCache[picked.index].job : null;
    },
    flushNow() {
      return enqueue(async () => {
        if (!dashboardReady || dashboardCache.length === 0) {
          return { ok: false, reason: "loading" };
        }
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        rosterDirty = true;
        const result = await flushPending();
        if (!result.ok) {
          armFlush(FLUSH_RETRY_MS);
          return { ok: false, reason: "failed" };
        }
        if (hasSheetWork()) {
          armFlush(FLUSH_WINDOW_MS);
        }
        return { ok: true, ...result };
      });
    },
    noteReport({ logRow, absenceRow, nickname, patch }) {
      let attendance = "skipped";
      if (patch) {
        attendance = applyToCache(nickname, patch);
        if (attendance === "updated") {
          pending.patches.push({ nickname, patch: { ...patch } });
        }
      }
      if (logRow) {
        pending.logs.push(logRow);
      }
      if (absenceRow) {
        pending.absences.push(absenceRow);
        const name = String(absenceRow[1] ?? "").trim().toLowerCase();
        const absenceDate = String(absenceRow[3] ?? "").trim();
        if (name && absenceDate === seoulDayKey().replaceAll("-", ".")) {
          todayAbsenceNames.add(name);
        }
      }
      try {
        persistPending();
      } catch (error) {
        console.error("모아 둔 시트 기록을 저장하지 못했습니다.", error);
      }
      armFlush(FLUSH_WINDOW_MS);
      return attendance;
    },
    startDayWatcher() {
      const tick = () => {
        enqueue(() => catchUpDay()).catch((error) => console.error("대시보드 날짜 갱신 실패", error));
      };
      tick();
      const dayTimer = setInterval(tick, 30_000);
      dayTimer.unref?.();
      const rosterTimer = setInterval(() => {
        enqueue(() => refreshRoster()).catch((error) => console.error("대시보드 명단 갱신 실패", error));
      }, ROSTER_REFRESH_MS);
      rosterTimer.unref?.();
    },
  };
}
