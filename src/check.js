import { buildModal } from "./modal.js";
import {
  clockTime,
  formatLogTime,
  normalizeClockTime,
  normalizeMonthDay,
  normalizeReportDate,
  toBulletList,
} from "./format.js";
import { displayNameKey, matchScore, pickPerson } from "./match.js";
import { createGuildSettings, describeGuildSettings, parseSheetLink, rosterIndexes } from "./guilds.js";
import { applyPeoplePatch, mergeDashboard, rosterPeopleFromSheet } from "./sheets.js";
import {
  decideReviewerClose,
  decideSaturatedClose,
  lookupReviewerTask,
  parseTaskSheet,
  taskAllowsClose,
} from "./reviewer-tasks.js";
import { REPORTS } from "./reports.js";

for (const report of REPORTS) {
  const json = buildModal(report, "수습 연구원", report.correctionChoice ? "daily" : null).toJSON();
  const expectedCount = report.absenceDates ? 5 : 3;
  if (json.components.length !== expectedCount) {
    throw new Error(`${report.id} 모달 구성 요소가 ${expectedCount}개가 아닙니다.`);
  }
  if (!json.components.some((component) => component.content?.includes("수습 연구원"))) {
    throw new Error("대시보드 역할이 모달에 읽기 전용으로 표시되지 않았습니다.");
  }
}

const absentReport = REPORTS.find((report) => report.id === "absent");
const absentModal = buildModal(absentReport, "수습 연구원").toJSON();
if (
  absentModal.components[2].component?.custom_id !== "absenceDate" ||
  absentModal.components[3].component?.custom_id !== "replacementDate"
) {
  throw new Error("불참 보고 날짜 입력칸이 없습니다.");
}

const correctionReport = REPORTS.find((report) => report.id === "correction");
const correction = buildModal(correctionReport, "수습 연구원", "daily").toJSON();
const closeCorrection = buildModal(correctionReport, "수습 연구원", "close").toJSON();
if (
  correction.components[0].component?.custom_id !== "clockIn" ||
  closeCorrection.components[0].component?.custom_id !== "clockOut"
) {
  throw new Error("정정 유형에 맞는 시간 입력칸이 없습니다.");
}

const date = normalizeReportDate("2026.9.29 13:00");
if (date !== "2026.09.29 13:00") {
  throw new Error(`날짜 정규화 결과가 예상과 다릅니다: ${date}`);
}
if (normalizeReportDate("어제") !== null) {
  throw new Error("잘못된 날짜를 통과시켰습니다.");
}

const bullets = toBulletList("- GM-006 과제 완료 및 리뷰\n추가 확인");
if (bullets !== "• GM-006 과제 완료 및 리뷰\n• 추가 확인") {
  throw new Error(`글머리표 변환 결과가 예상과 다릅니다: ${bullets}`);
}

if (formatLogTime(new Date("2026-10-22T00:54:07Z")) !== "2026-10-22 09:54:07") {
  throw new Error("로그 시각이 한국 시간 초 단위가 아닙니다.");
}
if (clockTime("2026.09.29 13:05") !== "13:05") {
  throw new Error("시각 추출에 실패했습니다.");
}
if (normalizeClockTime("9:05") !== "09:05" || normalizeClockTime("25:00") !== null) {
  throw new Error("출퇴근시간 정규화에 실패했습니다.");
}
const fixedNow = new Date("2026-10-06T06:00:00Z");
if (
  normalizeMonthDay("10.07", fixedNow) !== "2026.10.07" ||
  normalizeMonthDay("1월 2일", fixedNow) !== "2027.01.02" ||
  normalizeMonthDay("2.30", fixedNow) !== null
) {
  throw new Error("월일 정규화에 실패했습니다.");
}
if (matchScore("주환서_러닝헬퍼", "주환서") !== 2 || matchScore("주환서", "주환서") !== 2) {
  throw new Error("이름 비교 점수가 예상과 다릅니다.");
}
if (matchScore("다른사람_주환서", "주환서") !== 0 || matchScore("주환서러닝헬퍼", "주환서") !== 0) {
  throw new Error("언더바 앞부분만 비교해야 합니다.");
}
if (displayNameKey("Song Junho_조교") !== "Song Junho") {
  throw new Error("로그용 디스코드 이름 추출에 실패했습니다.");
}
const picked = pickPerson("주환서_러닝헬퍼", [{ name: "김민수" }, { name: "주환서" }]);
if (picked.status !== "found" || picked.index !== 1) {
  throw new Error("대시보드 대상 찾기에 실패했습니다.");
}

const dashboardPerson = {
  job: "러닝헬퍼",
  name: "주환서",
  status: "퇴근",
  clockIn: "09:00",
  clockOut: "18:00",
  judgedAt: "2026.10.07 18:00",
  corrected: false,
  absent: false,
};
const roster = [{ name: "주환서", job: "러닝헬퍼" }];
const kept = mergeDashboard(roster, [dashboardPerson], {
  resetTimes: false,
  absentNames: new Set(),
  now: "-",
});
if (kept[0].clockOut !== "18:00") {
  throw new Error("명단 갱신이 퇴근시간을 지웠습니다.");
}
const reset = mergeDashboard(roster, [dashboardPerson], {
  resetTimes: true,
  absentNames: new Set(),
  now: "-",
});
if (reset[0].clockOut !== "-" || reset[0].status !== "미출근") {
  throw new Error("자정 초기화가 퇴근시간을 비우지 않았습니다.");
}
const absent = mergeDashboard(roster, [dashboardPerson], {
  resetTimes: false,
  absentNames: new Set(["주환서"]),
  now: "2026.10.07 00:00",
});
if (absent[0].status !== "불참" || absent[0].clockOut !== "18:00" || absent[0].absent !== true) {
  throw new Error("불참 갱신이 기존 시각을 잃었습니다.");
}
const patched = applyPeoplePatch([dashboardPerson], "주환서_러닝헬퍼", {
  status: "퇴근",
  clockOut: "19:00",
  judgedAt: "2026.10.07 19:00",
});
if (patched.status !== "updated" || patched.people[0].clockOut !== "19:00" || patched.people[0].clockIn !== "09:00") {
  throw new Error("퇴근 반영이 해당 시각만 고치지 않았습니다.");
}
const missed = applyPeoplePatch([dashboardPerson], "없는사람", { clockOut: "19:00" });
if (missed.status !== "not_found" || missed.people[0].clockOut !== "18:00") {
  throw new Error("없는 닉네임이 대시보드를 바꿨습니다.");
}
const rosterSheet = Array.from({ length: 9 }, () => ["안내", "예전 이름"]);
rosterSheet.push(["", "이름", "", "지원직무", "", "", "", "근무 상태"]);
rosterSheet.push(["", "김근무", "", "리뷰어", "", "", "", "근무중"]);
rosterSheet.push(["", "김종료", "", "리뷰어", "", "", "", "근무종료"]);
rosterSheet.push(["", "김디자인", "", "디자인 러닝헬퍼", "", "", "", "근무 중"]);
rosterSheet.push(["", "김근무", "", "수습 연구원", "", "", "", "근무중"]);
const unifiedRoster = rosterPeopleFromSheet(rosterSheet);
if (
  unifiedRoster.length !== 2 ||
  unifiedRoster[0].name !== "김근무" ||
  unifiedRoster[0].job !== "리뷰어" ||
  unifiedRoster[1].job !== "디자인 러닝헬퍼"
) {
  throw new Error("통합 명단에서 근무중 인원과 직무를 읽지 못했습니다.");
}
const shiftedRoster = rosterPeopleFromSheet(
  [
    ["이름", "직무", "근무상태"],
    ["김이동", "리뷰어", "근무중"],
  ],
  rosterIndexes({ headerRow: 1, nameColumn: 1, jobColumn: 2, statusColumn: 3, activeStatus: "근무중" }),
);
if (shiftedRoster.length !== 1 || shiftedRoster[0].job !== "리뷰어") {
  throw new Error("명단 열 위치 설정으로 사람을 읽지 못했습니다.");
}
const plainHeaderRoster = rosterPeopleFromSheet(
  [
    ["이름", "직무", "상태"],
    ["송준호", "백수", "근무중"],
  ],
  rosterIndexes({ headerRow: 1, nameColumn: 1, jobColumn: 2, statusColumn: 3, activeStatus: "근무중" }),
);
if (plainHeaderRoster.length !== 1 || plainHeaderRoster[0].name !== "송준호" || plainHeaderRoster[0].job !== "백수") {
  throw new Error("헤더 글자가 달라도 지정한 행과 열에서 사람을 읽지 못했습니다.");
}
const blankServer = createGuildSettings({ roles: ["리뷰어"] });
if (blankServer.sheets.logSpreadsheetId || blankServer.channels.daily || blankServer.roster.nameColumn) {
  throw new Error("새 서버 설정이 비어 있지 않습니다.");
}
const describedBlank = describeGuildSettings(blankServer);
if (!describedBlank.includes("대시보드: 없음") || !describedBlank.includes("명단 열: 없음")) {
  throw new Error("빈 설정을 없음으로 보여 주지 못했습니다.");
}
const parsedLink = parseSheetLink(
  "https://docs.google.com/spreadsheets/d/abc123_DEF/edit?gid=2114634129#gid=2114634129",
);
if (parsedLink?.spreadsheetId !== "abc123_DEF" || parsedLink.sheetId !== 2114634129) {
  throw new Error("시트 링크에서 파일과 탭 번호를 읽지 못했습니다.");
}
if (parseSheetLink("https://docs.google.com/spreadsheets/d/abc123_DEF/edit")) {
  throw new Error("탭 번호가 없는 시트 링크를 통과시켰습니다.");
}
const described = describeGuildSettings({
  channels: { daily: "daily-channel", close: null, absent: null },
  sheets: { logSpreadsheetId: "log", logSheetId: 1 },
  roster: { headerRow: 10, nameColumn: 2, jobColumn: 4, statusColumn: 8, activeStatus: "근무중" },
});
if (!described.includes("daily-channel") || !described.includes("/spreadsheets/d/log/edit?gid=1")) {
  throw new Error("서버 설정 안내가 채널과 시트 주소를 빠뜨렸습니다.");
}

const taskRows = Array.from({ length: 13 }, () => []);
taskRows.push(["", "", "10/12", "10/13", "10/14", "10/15", "10/16", "10/17", "10/18"]);
taskRows.push(["김리뷰", "", "1", "1", "1", "1", "진행중"]);
taskRows.push(["김완료", "", "1", "1", "1", "1", "2"]);
taskRows.push(["김공백", "", "1", "1", "1", "1", ""]);
const taskCache = parseTaskSheet(taskRows, { today: "2026-10-16" });
if (lookupReviewerTask(taskCache, "김리뷰_리뷰어") !== "pending") {
  throw new Error("진행중인 오늘 작업을 마감 가능으로 봤습니다.");
}
if (lookupReviewerTask(taskCache, "김완료") !== "done") {
  throw new Error("1 이상인 오늘 작업을 마감 불가로 봤습니다.");
}
if (lookupReviewerTask(taskCache, "김공백") !== "pending") {
  throw new Error("빈 오늘 작업을 마감 가능으로 봤습니다.");
}
if (taskAllowsClose(0) || taskAllowsClose("0") || !taskAllowsClose("1") || !taskAllowsClose(3)) {
  throw new Error("작업 수량 판정이 1 미만을 통과시켰습니다.");
}
if (decideReviewerClose({ status: "done", readsInWindow: 30 }) !== "allow") {
  throw new Error("캐시에 있는 완료 작업을 읽기 제한 때문에 막았습니다.");
}
if (decideReviewerClose({ status: "pending", readsInWindow: 0 }) !== "refresh") {
  throw new Error("남은 작업이 캐시에 있어도 30회 미만이면 시트를 다시 읽어야 합니다.");
}
if (decideReviewerClose({ status: "pending", readsInWindow: 30 }) !== "block") {
  throw new Error("읽기 30회 이후에는 캐시의 남은 작업으로 막아야 합니다.");
}
if (decideReviewerClose({ status: "missing", readsInWindow: 29 }) !== "refresh") {
  throw new Error("캐시에 없을 때 갱신을 시도하지 않았습니다.");
}
if (decideReviewerClose({ status: "missing", readsInWindow: 30 }) !== "retry") {
  throw new Error("읽기 30회 이후에도 즉시 갱신을 시도했습니다.");
}
if (decideReviewerClose({ status: "unloaded", readsInWindow: 30 }) !== "retry") {
  throw new Error("빈 캐시에서 30회 이후 재시도 안내로 가지 않았습니다.");
}
if (decideSaturatedClose({ status: "pending", cacheLoadedAt: 1, limitMarkedAt: 2, refreshPending: true }) !== "retry") {
  throw new Error("갱신 예약 중에는 남은 작업 안내로 가면 안 됩니다.");
}
if (decideSaturatedClose({ status: "done", cacheLoadedAt: 1, limitMarkedAt: 2, refreshPending: true }) !== "allow") {
  throw new Error("갱신 예약 중에도 이미 끝난 작업을 막았습니다.");
}
if (decideSaturatedClose({ status: "pending", cacheLoadedAt: 5, limitMarkedAt: 2, refreshPending: false }) !== "block") {
  throw new Error("갱신 뒤에 남은 작업을 통과시켰습니다.");
}

console.log("확인 완료");
