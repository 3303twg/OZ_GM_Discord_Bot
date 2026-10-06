import { buildModal } from "./modal.js";
import { clockTime, normalizeClockTime, normalizeReportDate, toBulletList } from "./format.js";
import { displayNameKey, matchScore, pickPerson } from "./match.js";
import { REPORTS } from "./reports.js";

for (const report of REPORTS) {
  const json = buildModal(report, "수습 연구원", report.correctionChoice ? "daily" : null).toJSON();
  if (json.components.length !== 3) {
    throw new Error(`${report.id} 모달 구성 요소가 3개가 아닙니다.`);
  }
  if (!json.components.some((component) => component.content?.includes("수습 연구원"))) {
    throw new Error("대시보드 역할이 모달에 읽기 전용으로 표시되지 않았습니다.");
  }
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

if (clockTime("2026.09.29 13:05") !== "13:05") {
  throw new Error("시각 추출에 실패했습니다.");
}
if (normalizeClockTime("9:05") !== "09:05" || normalizeClockTime("25:00") !== null) {
  throw new Error("출퇴근시간 정규화에 실패했습니다.");
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

console.log("확인 완료");
