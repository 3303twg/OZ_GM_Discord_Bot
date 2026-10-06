function seoulParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

export function formatSeoulNow(date = new Date()) {
  const parts = seoulParts(date);
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
}

export function seoulDayKey(date = new Date()) {
  const parts = seoulParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function normalizeMonthDay(input, now = new Date()) {
  const match = input.trim().match(/^(\d{1,2})(?:[./-]|월\s*)(\d{1,2})(?:일)?$/);
  if (!match) {
    return null;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  const today = seoulParts(now);
  let year = Number(today.year);

  function validDate(targetYear) {
    const date = new Date(Date.UTC(targetYear, month - 1, day));
    return (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      date.getUTCFullYear() === targetYear &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }

  if (!validDate(year)) {
    return null;
  }
  const pad = (number) => String(number).padStart(2, "0");
  const monthDay = `${pad(month)}.${pad(day)}`;
  if (monthDay < `${today.month}.${today.day}`) {
    year += 1;
    if (!validDate(year)) {
      return null;
    }
  }
  return `${year}.${monthDay}`;
}

export function clockTime(reportDate) {
  const match = reportDate.match(/(\d{2}):(\d{2})$/);
  return match ? `${match[1]}:${match[2]}` : reportDate;
}

export function normalizeClockTime(input) {
  const match = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function normalizeReportDate(input) {
  const match = input
    .trim()
    .match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null;
  }

  const pad = (number) => String(number).padStart(2, "0");
  return `${year}.${pad(month)}.${pad(day)} ${pad(hour)}:${pad(minute)}`;
}

export function toBulletList(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `• ${line.replace(/^[-*•]\s*/, "")}`);

  return lines.join("\n").slice(0, 1024);
}
