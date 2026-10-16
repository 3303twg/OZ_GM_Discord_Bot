import { nameKey } from "./match.js";

export const TASK_READ_LIMIT = 30;
export const TASK_NAME_ROW = 15;
export const TASK_NAME_COLUMN = 15;
export const TASK_DAY_START = 17;
export const TASK_DAY_END = 23;

const WEEKDAYS = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };

export function gridOrigin(range) {
  const match = String(range ?? "").match(/!([A-Z]+)(\d+)/);
  if (!match) {
    return { startRow: 1, startColumn: TASK_NAME_COLUMN };
  }
  return { startRow: Number(match[2]), startColumn: columnNumber(match[1]) - 1 };
}

export function taskAllowsClose(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, "");
  const match = text.match(/^-?\d+(?:\.\d+)?/);
  if (!match) {
    return false;
  }
  return Number(match[0]) >= 1;
}

export function parseTaskSheet(rows, { startRow = 1, startColumn = TASK_NAME_COLUMN, today }) {
  const nameIndex = TASK_NAME_COLUMN - startColumn;
  const dayStart = TASK_DAY_START - startColumn;
  const dayEnd = TASK_DAY_END - startColumn;
  const year = Number(String(today).slice(0, 4));
  const headers = [];
  const people = [];

  rows.forEach((row, index) => {
    const sheetRow = startRow + index;
    if (sheetRow < TASK_NAME_ROW) {
      for (let column = dayStart; column <= dayEnd; column += 1) {
        const parsed = parseHeaderCell(row?.[column], year);
        if (parsed) {
          headers.push({ column, ...parsed });
        }
      }
      return;
    }
    const name = String(row?.[nameIndex] ?? "").trim();
    if (!name) {
      return;
    }
    people.push({ name, row });
  });

  const column = columnForToday(headers, today);
  return {
    loaded: true,
    column,
    people: people.map((person) => ({
      name: person.name,
      value: column == null ? "" : person.row?.[column],
    })),
  };
}

export function lookupReviewerTask(cache, nickname) {
  if (!cache?.loaded) {
    return "unloaded";
  }
  const key = nameKey(nickname);
  const person = cache.people.find((item) => nameKey(item.name) === key);
  if (!person) {
    return "missing";
  }
  if (cache.column == null) {
    return "no_column";
  }
  return taskAllowsClose(person.value) ? "done" : "pending";
}

export function decideSaturatedClose({ status, cacheLoadedAt = 0, limitMarkedAt = 0, refreshPending = false }) {
  if (status === "done" || status === "no_column") {
    return "allow";
  }
  if (refreshPending || !cacheLoadedAt || cacheLoadedAt < limitMarkedAt) {
    return "retry";
  }
  if (status === "pending") {
    return "block";
  }
  if (status === "missing") {
    return "missing";
  }
  return "retry";
}

export function decideReviewerClose({ status, readsInWindow, cacheFresh = false, limit = TASK_READ_LIMIT }) {
  if (status === "done" || status === "no_column") {
    return "allow";
  }
  if (status === "pending") {
    return readsInWindow < limit ? "refresh" : "block";
  }
  if (status === "missing" && cacheFresh) {
    return "missing";
  }
  return readsInWindow < limit ? "refresh" : "retry";
}

function columnForToday(headers, today) {
  const dated = headers.filter((header) => header.dateKey === today);
  if (dated.length > 0) {
    return dated[dated.length - 1].column;
  }
  const weekday = weekdayOf(today);
  const named = headers.filter((header) => header.dateKey == null && header.weekday === weekday);
  return named.length > 0 ? named[named.length - 1].column : null;
}

function parseHeaderCell(value, year) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "number" && value > 20000 && value < 80000) {
    return { dateKey: serialToDateKey(value) };
  }
  const text = String(value).trim();
  const serial = text.match(/^\d{5}(?:\.\d+)?$/);
  if (serial) {
    return { dateKey: serialToDateKey(Number(serial[0])) };
  }
  const weekday = text.match(/^(일|월|화|수|목|금|토)(?:요일)?$/);
  if (weekday) {
    return { weekday: WEEKDAYS[weekday[1]] };
  }
  const full = text.match(/(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/);
  if (full) {
    return { dateKey: isoDate(full[1], full[2], full[3]) };
  }
  const monthDay =
    text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/) ||
    text.match(/(?:^|[^\d])(\d{1,2})\s*[./-]\s*(\d{1,2})(?!\d)/);
  if (monthDay) {
    return { dateKey: isoDate(year, monthDay[1], monthDay[2]) };
  }
  return null;
}

function serialToDateKey(serial) {
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function weekdayOf(dateKey) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function columnNumber(letters) {
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}
