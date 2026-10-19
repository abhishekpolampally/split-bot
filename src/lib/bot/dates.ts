/**
 * Day words in chat ("yesterday", "last saturday", "12th oct") → a range of calendar days in India.
 * Days are "yyyy-mm-dd" strings in IST, so comparisons don't depend on the server's time zone.
 */

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86400_000;

export interface DayRange {
  /** Inclusive, "yyyy-mm-dd" in IST. */
  from: string;
  to: string;
  /** How to say it back: "yesterday", "Saturday 17 Oct", "last week". */
  label: string;
}

/** The calendar day in India for an instant. */
export function istDay(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant an IST day starts, for database range queries. */
export function istDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

const WEEKDAYS: [RegExp, number][] = [
  [/^sun/, 0],
  [/^mon/, 1],
  [/^tue/, 2],
  [/^wed/, 3],
  [/^thu/, 4],
  [/^fri/, 5],
  [/^sat/, 6],
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DAY_NUM = "(\\d{1,2})(?:st|nd|rd|th)?";

/** "Saturday 17 Oct" for a day string. */
export function dayLabel(day: string): string {
  return new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(`${day}T00:00:00Z`))
    .replace(",", "");
}

/** "Sat 17 Oct" for an instant, in IST. Used on buttons, where space is short. */
export function shortDay(d: Date): string {
  return dayLabel(istDay(d)).replace(/^(\w{3})\w*/, "$1");
}

type Hit = DayRange & { start: number; end: number };

/**
 * Find the first day phrase in lowercase `t`. Weekdays mean the most recent one (today counts,
 * except for "last saturday"), and dates without a year mean the most recent one.
 */
export function findDayRange(t: string, now: Date): Hit | null {
  const today = istDay(now);
  const at = (m: RegExpMatchArray, r: DayRange): Hit => ({ ...r, start: m.index!, end: m.index! + m[0].length });
  const one = (day: string, label: string): DayRange => ({ from: day, to: day, label });

  let m = t.match(/\b(?:the\s+)?(?:day\s+before\s+yesterday|parso)\b/);
  if (m) return at(m, one(addDays(today, -2), "the day before yesterday"));
  m = t.match(/\b(?:yesterday(?:'s)?|yday|kal|last\s+night(?:'s)?)\b/);
  if (m) return at(m, one(addDays(today, -1), "yesterday"));
  m = t.match(/\b(?:today(?:'s)?|aaj|tonight(?:'s)?|this\s+(?:morning|afternoon|evening))\b/);
  if (m) return at(m, one(today, "today"));

  m = t.match(/\b(?:(last|this|past|previous|on)\s+)?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?(?:'s|s)?\b/);
  if (m) {
    const target = WEEKDAYS.find(([re]) => re.test(m![2]))![1];
    let back = (weekdayOf(today) - target + 7) % 7;
    if (back === 0 && (m[1] === "last" || m[1] === "previous")) back = 7;
    const day = addDays(today, -back);
    return at(m, one(day, dayLabel(day)));
  }

  m = t.match(/\b(last|previous|this|past)\s+week(?:'s)?\b/);
  if (m) {
    if (m[1] === "past") return at(m, { from: addDays(today, -6), to: today, label: "the past week" });
    const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
    return m[1] === "this"
      ? at(m, { from: monday, to: today, label: "this week" })
      : at(m, { from: addDays(monday, -7), to: addDays(monday, -1), label: "last week" });
  }

  m = t.match(/\b(last|previous|this)\s+month(?:'s)?\b/);
  if (m) {
    const [y, mo] = today.split("-").map(Number);
    if (m[1] === "this") return at(m, { from: `${today.slice(0, 7)}-01`, to: today, label: "this month" });
    const first = new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 10);
    return at(m, { from: first, to: addDays(`${today.slice(0, 7)}-01`, -1), label: "last month" });
  }

  m = t.match(new RegExp(`\\b${DAY_NUM}\\s+(?:of\\s+)?${MONTH_RE}\\b`)) ?? t.match(new RegExp(`\\b${MONTH_RE}\\s+${DAY_NUM}\\b`));
  if (m) {
    const [dayStr, monStr] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    const month = MONTHS.indexOf(monStr.slice(0, 3));
    const dom = Number(dayStr);
    let year = Number(today.slice(0, 4));
    const make = (yr: number) => new Date(Date.UTC(yr, month, dom)).toISOString().slice(0, 10);
    if (dom >= 1 && dom <= 31) {
      if (make(year) > today) year -= 1;
      const day = make(year);
      return at(m, one(day, dayLabel(day)));
    }
  }
  return null;
}
