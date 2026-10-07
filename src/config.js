import fs from "node:fs";
import path from "node:path";

const REQUIRED = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "GOOGLE_SERVICE_ACCOUNT_PATH",
];

export function loadConfig() {
  const missing = REQUIRED.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`.env에 다음 값이 없습니다: ${missing.join(", ")}`);
  }

  const keyPath = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_PATH);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`서비스 계정 키 파일이 없습니다: ${keyPath}`);
  }

  const rolesPath = path.resolve("config/roles.json");
  const roles = JSON.parse(fs.readFileSync(rolesPath, "utf8"));
  if (!Array.isArray(roles) || roles.length === 0 || roles.some((role) => typeof role !== "string")) {
    throw new Error("config/roles.json은 역할 이름 문자열 배열이어야 합니다.");
  }
  if (roles.length > 25) {
    throw new Error("역할은 드롭다운 제한 때문에 25개까지 넣을 수 있습니다.");
  }

  return {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    spreadsheetId: process.env.LOG_SPREADSHEET_ID?.trim() || "1urDBEBaRv7kVaAgwFozWxBR8kNAw75GIYet_zPQrmoY",
    logSheetId: Number(process.env.LOG_SHEET_GID || 0),
    dashboardSheetId: Number(process.env.DASHBOARD_SHEET_GID || 218253518),
    rosterSpreadsheetId: process.env.ROSTER_SPREADSHEET_ID?.trim() || "1ANwZJNE7521MF8xmAGsKIZE27MRCC6Ezl9peYc5W75s",
    rosterSheetId: Number(process.env.ROSTER_SHEET_GID || 2107231157),
    secondRosterSheetId: Number(process.env.SECOND_ROSTER_SHEET_GID || 2007394471),
    thirdRosterSpreadsheetId:
      process.env.THIRD_ROSTER_SPREADSHEET_ID?.trim() || "1TP56kkbfB_NjKFM57tFCcGAVr5vjmCIcmFiKVfnh88Y",
    thirdRosterSheetId: Number(process.env.THIRD_ROSTER_SHEET_GID || 0),
    serviceAccountPath: keyPath,
    roles,
  };
}
