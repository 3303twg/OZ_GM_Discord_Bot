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
const statePath = path.resolve("data/dashboard-day.json");
const FIRST_ROSTER_ROLES = new Map([
  ["교육자료 리뷰어", "리뷰어"],
  ["러닝헬퍼(단기 조교)", "러닝헬퍼"],
]);

export function createWorkbook(config) {
  const auth = new GoogleAuth({
    keyFile: config.serviceAccountPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const titles = new Map();
  let chain = Promise.resolve();
  let dashboardCache = [];

  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
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

  async function ensureHeader(spreadsheetId, title, headers, a1) {
    const rows = await readValues(spreadsheetId, title, a1);
    const current = rows[0] ?? [];
    const matches = headers.every((header, index) => current[index] === header);
    if (!matches) {
      await writeValues(spreadsheetId, title, a1, [headers]);
    }
  }

  async function ensureDashboardCheckboxes() {
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

  function rosterPeople(values, nameIndex, roleOf) {
    if (!values.length) {
      return [];
    }
    const firstStatus = String(values[0][11] ?? "").replace(/\s+/g, "");
    const records = firstStatus === "근무중" ? values : values.slice(1);
    return records
      .map((row) => ({
        job: roleOf(row),
        name: String(row[nameIndex] ?? "").trim(),
        employment: String(row[11] ?? "").replace(/\s+/g, ""),
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
    return values.slice(1).map((row) => ({
      job: String(row[0] ?? "").trim(),
      name: String(row[1] ?? "").trim(),
      status: String(row[2] ?? "").trim() || ABSENT,
      clockIn: String(row[3] ?? "").trim() || "-",
      clockOut: String(row[4] ?? "").trim() || "-",
      judgedAt: String(row[5] ?? "").trim() || "-",
      corrected: row[6] === true || String(row[6] ?? "").toUpperCase() === "TRUE",
      absent: row[7] === true || String(row[7] ?? "").toUpperCase() === "TRUE",
    })).filter((person) => person.name);
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

  async function latestAbsenceNamesForDate(targetDate) {
    const logTitle = await sheetTitle(config.spreadsheetId, config.logSheetId);
    const rows = await readValues(config.spreadsheetId, logTitle, "A:I");
    const latestByName = new Map();
    for (let index = rows.length - 1; index >= 1; index -= 1) {
      const row = rows[index];
      if (String(row[1] ?? "").trim() !== "업무 불참 보고") {
        continue;
      }
      const name = String(row[2] ?? "").trim().toLowerCase();
      if (name && !latestByName.has(name)) {
        latestByName.set(name, String(row[7] ?? "").trim());
      }
    }
    return new Set(
      [...latestByName.entries()]
        .filter(([, absenceDate]) => absenceDate === targetDate)
        .map(([name]) => name),
    );
  }

  async function syncRoster(resetTimes) {
    const firstRosterTitle = await sheetTitle(config.rosterSpreadsheetId, config.rosterSheetId);
    const secondRosterTitle = await sheetTitle(config.rosterSpreadsheetId, config.secondRosterSheetId);
    const dashboardTitle = await sheetTitle(config.spreadsheetId, config.dashboardSheetId);
    const [firstValues, secondValues] = await Promise.all([
      readValues(config.rosterSpreadsheetId, firstRosterTitle, "A:L"),
      readValues(config.rosterSpreadsheetId, secondRosterTitle, "A:L"),
    ]);
    const roster = mergeRosterPeople(
      rosterPeople(firstValues, 1, (row) => {
        const sourceRole = String(row[3] ?? "").trim();
        return FIRST_ROSTER_ROLES.get(sourceRole) ?? sourceRole;
      }),
      rosterPeople(secondValues, 2, () => "수습 연구원"),
    );
    const today = seoulDayKey().replaceAll("-", ".");
    const scheduledAbsences = await latestAbsenceNamesForDate(today);
    await ensureHeader(config.spreadsheetId, dashboardTitle, DASHBOARD_HEADERS, "A1:H1");
    const current = dashboardRows(await readValues(config.spreadsheetId, dashboardTitle, "A:H"));
    const merged = roster.map((person) => {
      const existing = current.find((row) => row.name === person.name);
      if (!existing || resetTimes) {
        const isAbsent = scheduledAbsences.has(person.name.toLowerCase());
        return {
          job: person.job,
          name: person.name,
          status: isAbsent ? "불참" : ABSENT,
          clockIn: "-",
          clockOut: "-",
          judgedAt: isAbsent ? formatSeoulNow() : "-",
          corrected: false,
          absent: isAbsent,
        };
      }
      if (scheduledAbsences.has(person.name.toLowerCase())) {
        return {
          ...existing,
          job: person.job || existing.job,
          name: person.name,
          status: "불참",
          judgedAt: existing.status === "불참" ? existing.judgedAt : formatSeoulNow(),
          absent: true,
        };
      }
      return { ...existing, job: person.job || existing.job, name: person.name };
    });
    await writeValues(config.spreadsheetId, dashboardTitle, `A1:H${Math.max(merged.length + 1, 1)}`, [
      DASHBOARD_HEADERS,
      ...merged.map(toCells),
    ]);
    await ensureDashboardCheckboxes();
    if (current.length > merged.length) {
      await clearValues(config.spreadsheetId, dashboardTitle, `A${merged.length + 2}:H1000`);
    }
    dashboardCache = merged;
    return merged;
  }

  async function appendLog(row) {
    const title = await sheetTitle(config.spreadsheetId, config.logSheetId);
    await ensureHeader(config.spreadsheetId, title, LOG_HEADERS, "A1:I1");
    await request(
      config.spreadsheetId,
      `/values/${rangeOf(title, "A:I")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: "POST", body: JSON.stringify({ values: [row] }) },
    );
  }

  async function markAttendance(nickname, patch) {
    const title = await sheetTitle(config.spreadsheetId, config.dashboardSheetId);
    const people = dashboardRows(await readValues(config.spreadsheetId, title, "A:H"));
    const picked = pickPerson(nickname, people);
    if (picked.status !== "found") {
      return picked.status;
    }
    const person = { ...people[picked.index], ...patch };
    await writeValues(config.spreadsheetId, title, `A${picked.index + 2}:H${picked.index + 2}`, [toCells(person)]);
    dashboardCache = people.map((item, index) => (index === picked.index ? person : item));
    return "updated";
  }

  async function catchUpDay() {
    const today = seoulDayKey();
    const saved = readDay();
    if (saved === today) {
      if (dashboardCache.length === 0) {
        await syncRoster(false);
      }
      return;
    }
    await syncRoster(saved !== null);
    writeDay(today);
    console.log(saved === null ? "대시보드 명단을 채웠습니다." : "자정이 지나 출근·퇴근 시각을 비웠습니다.");
  }

  return {
    roleForNickname(nickname) {
      const picked = pickPerson(nickname, dashboardCache);
      return picked.status === "found" ? dashboardCache[picked.index].job : null;
    },
    refreshRoleForNickname(nickname) {
      return enqueue(async () => {
        await syncRoster(false);
        const picked = pickPerson(nickname, dashboardCache);
        return picked.status === "found" ? dashboardCache[picked.index].job : null;
      });
    },
    appendLog(row) {
      return enqueue(() => appendLog(row));
    },
    async recordAttendance(nickname, patch) {
      return enqueue(async () => {
        await syncRoster(false);
        return markAttendance(nickname, patch);
      });
    },
    startDayWatcher() {
      const tick = () => {
        enqueue(() => catchUpDay()).catch((error) => console.error("대시보드 날짜 갱신 실패", error));
      };
      tick();
      const timer = setInterval(tick, 30_000);
      timer.unref?.();
    },
  };
}
