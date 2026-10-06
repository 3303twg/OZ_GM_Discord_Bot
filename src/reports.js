export const REPORTS = [
  {
    id: "daily",
    buttonLabel: "일일 업무 보고",
    modalTitle: "일일 업무 보고",
    contentLabel: "맡은 업무",
    outputLabel: "일일 업무",
    contentPlaceholder: "-",
  },
  {
    id: "close",
    buttonLabel: "일일 마감 보고",
    modalTitle: "일일 마감 보고",
    contentLabel: "마감 내용",
    outputLabel: "일일 마감",
    contentPlaceholder: "-",
    },
    {
        id: "correction",
        buttonLabel: "업무 정정 보고",
        modalTitle: "업무 정정 보고",
    correctionChoice: true,
        contentLabel: "정정 업무",
        outputLabel: "업무 정정 내용",
        contentPlaceholder: "정정할 업무 내용을 입력하세요",
    },
  {
    id: "absent",
    buttonLabel: "업무 불참 보고",
    modalTitle: "업무 불참 보고",
    contentLabel: "불참 사유",
    outputLabel: "불참 사유",
    contentPlaceholder: "불참 사유를 입력하세요",
  },
];

export function findReport(id) {
  return REPORTS.find((report) => report.id === id);
}
