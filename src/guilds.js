import fs from "node:fs";
import path from "node:path";

const guildDir = path.resolve("data/guilds");

export function guildSettingsPath(guildId) {
  return path.join(guildDir, `${guildId}.json`);
}

export function guildStatePaths(guildId) {
  const dir = path.resolve("data/state", String(guildId));
  return {
    pendingPath: path.join(dir, "pending-writes.json"),
    dayPath: path.join(dir, "dashboard-day.json"),
  };
}

export function createGuildSettings(envConfig) {
  return {
    channels: {
      daily: null,
      close: null,
      absent: null,
    },
    sheets: blankSheets(),
    roster: {
      headerRow: null,
      nameColumn: null,
      jobColumn: null,
      statusColumn: null,
      activeStatus: null,
    },
    roles: [...envConfig.roles],
    panel: {
      channelId: null,
      messageId: null,
    },
  };
}

export function rosterIndexes(roster = {}) {
  return {
    headerRow: Number(roster.headerRow) || null,
    nameIndex: columnIndex(roster.nameColumn),
    jobIndex: columnIndex(roster.jobColumn),
    statusIndex: columnIndex(roster.statusColumn),
    activeStatus: roster.activeStatus ? String(roster.activeStatus) : null,
  };
}

export function guildSheetsReady(settings) {
  return missingGuildSettings(settings).length === 0;
}

export function missingGuildSettings(settings, { channelType } = {}) {
  const sheets = settings?.sheets ?? {};
  const roster = settings?.roster ?? {};
  const missing = [];
  if (!sheets.dashboardSpreadsheetId || !hasGid(sheets.dashboardSheetId)) {
    missing.push("대시보드 시트");
  }
  if (!sheets.logSpreadsheetId || !hasGid(sheets.logSheetId)) {
    missing.push("보고로그 시트");
  }
  if (channelType === "absent" && (!sheets.absenceSpreadsheetId || !hasGid(sheets.absenceSheetId))) {
    missing.push("업무불참 시트");
  }
  if (!sheets.rosterSpreadsheetId || !hasGid(sheets.rosterSheetId)) {
    missing.push("명단 시트");
  }
  if (!roster.nameColumn || !roster.jobColumn || !roster.statusColumn || !roster.headerRow) {
    missing.push("명단 열");
  }
  if (channelType && !settings?.channels?.[channelType]) {
    missing.push(`${channelLabel(channelType)} 채널`);
  }
  return missing;
}

export function describeGuildSettings(settings) {
  const sheets = settings?.sheets ?? {};
  const roster = settings?.roster ?? {};
  const channels = settings?.channels ?? {};
  const absence =
    !sheets.absenceSpreadsheetId || !hasGid(sheets.absenceSheetId)
      ? "없음"
      : sheetText(sheets.absenceSpreadsheetId, sheets.absenceSheetId);
  return [
    `업무 채널: ${channelText(channels.daily)}`,
    `마감 채널: ${channelText(channels.close)}`,
    `불참 채널: ${channelText(channels.absent)}`,
    `대시보드: ${sheetText(sheets.dashboardSpreadsheetId, sheets.dashboardSheetId)}`,
    `보고로그: ${sheetText(sheets.logSpreadsheetId, sheets.logSheetId)}`,
    `업무불참: ${absence}`,
    `명단: ${sheetText(sheets.rosterSpreadsheetId, sheets.rosterSheetId)}`,
    `리뷰어 작업: ${sheets.taskSpreadsheetId ? sheetText(sheets.taskSpreadsheetId, sheets.taskSheetId) : "없음"}`,
    `명단 열: ${rosterText(roster)}`,
  ].join("\n");
}

export function parseSheetLink(input) {
  const text = String(input ?? "").trim();
  const spreadsheetId = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] ?? null;
  const gid = text.match(/[#&?]gid=(\d+)/)?.[1];
  if (!spreadsheetId || gid == null) {
    return null;
  }
  return { spreadsheetId, sheetId: Number(gid) };
}

export function ensureGuild(guildId, envConfig) {
  const file = guildSettingsPath(guildId);
  if (fs.existsSync(file)) {
    return normalizeGuild(JSON.parse(fs.readFileSync(file, "utf8")), envConfig);
  }
  fs.mkdirSync(guildDir, { recursive: true });
  const settings = createGuildSettings(envConfig);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return settings;
}

export function readGuild(guildId, envConfig) {
  return ensureGuild(guildId, envConfig);
}

export function getGuildChannel(guildId, type) {
  const settings = readJson(guildSettingsPath(guildId));
  return settings?.channels?.[type] ?? null;
}

export function setGuildChannel(guildId, envConfig, type, channelId) {
  const settings = ensureGuild(guildId, envConfig);
  settings.channels[type] = channelId;
  writeGuild(guildId, settings);
  return settings;
}

export function getGuildPanel(guildId) {
  return readJson(guildSettingsPath(guildId))?.panel ?? null;
}

export function setGuildSheet(guildId, envConfig, type, link) {
  const parsed = parseSheetLink(link);
  if (!parsed) {
    return null;
  }
  const settings = ensureGuild(guildId, envConfig);
  const fields = {
    dashboard: ["dashboardSpreadsheetId", "dashboardSheetId"],
    log: ["logSpreadsheetId", "logSheetId"],
    absent: ["absenceSpreadsheetId", "absenceSheetId"],
    roster: ["rosterSpreadsheetId", "rosterSheetId"],
    task: ["taskSpreadsheetId", "taskSheetId"],
  }[type];
  if (!fields) {
    return null;
  }
  settings.sheets[fields[0]] = parsed.spreadsheetId;
  settings.sheets[fields[1]] = parsed.sheetId;
  writeGuild(guildId, settings);
  return settings;
}

export function setGuildRoster(guildId, envConfig, roster) {
  const settings = ensureGuild(guildId, envConfig);
  settings.roster = {
    ...settings.roster,
    headerRow: Number(roster.headerRow) || settings.roster.headerRow || 10,
    nameColumn: Number(roster.nameColumn),
    jobColumn: Number(roster.jobColumn),
    statusColumn: Number(roster.statusColumn),
    activeStatus: String(roster.activeStatus || settings.roster.activeStatus || "근무중"),
  };
  writeGuild(guildId, settings);
  return settings;
}

export function setGuildPanel(guildId, envConfig, channelId, messageId) {
  const settings = ensureGuild(guildId, envConfig);
  settings.panel = { channelId, messageId };
  writeGuild(guildId, settings);
}

function blankSheets() {
  return {
    logSpreadsheetId: "",
    logSheetId: null,
    dashboardSpreadsheetId: "",
    dashboardSheetId: null,
    absenceSpreadsheetId: "",
    absenceSheetId: null,
    rosterSpreadsheetId: "",
    rosterSheetId: null,
    taskSpreadsheetId: "",
    taskSheetId: null,
  };
}

function sheetText(spreadsheetId, sheetId) {
  if (!spreadsheetId || !hasGid(sheetId)) {
    return "없음";
  }
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${sheetId}#gid=${sheetId}`;
}

function channelText(channelId) {
  return channelId ? `<#${channelId}>` : "없음";
}

function rosterText(roster) {
  if (!roster.nameColumn || !roster.jobColumn || !roster.statusColumn || !roster.headerRow) {
    return "없음";
  }
  return `헤더 ${roster.headerRow}행, 이름 ${roster.nameColumn}열, 직무 ${roster.jobColumn}열, 근무상태 ${roster.statusColumn}열, 값 ${roster.activeStatus || "없음"}`;
}

function channelLabel(type) {
  return { daily: "업무", close: "마감", absent: "불참" }[type] ?? type;
}

function hasGid(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function normalizeGuild(settings, envConfig) {
  const created = createGuildSettings(envConfig);
  return {
    ...created,
    ...settings,
    channels: { ...created.channels, ...settings.channels },
    sheets: { ...created.sheets, ...settings.sheets },
    roster: { ...created.roster, ...settings.roster },
    roles: Array.isArray(settings.roles) && settings.roles.length > 0 ? settings.roles : created.roles,
    panel: { ...created.panel, ...settings.panel },
  };
}

function writeGuild(guildId, settings) {
  const file = guildSettingsPath(guildId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

function columnIndex(column) {
  const number = Number(column);
  return Number.isInteger(number) && number > 0 ? number - 1 : null;
}

function readJson(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
