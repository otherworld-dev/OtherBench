/**
 * Cron rules for scheduled tasks: the standard five fields (minute, hour, day
 * of month, month, day of week) with `*`, lists, ranges, steps, month and
 * weekday names, and the `@hourly`/`@daily`/`@weekly`/`@monthly`/`@yearly`
 * shortcuts. No seconds field and no `@reboot`. Pure, with no Node imports,
 * so the web UI checks a rule as it is typed. Evaluating a rule against the
 * clock is `nextRunAt` in `schedule.ts`, which runs it in the schedule's zone.
 *
 * Day of month and day of week follow Vixie cron. When neither field starts
 * with `*`, a date matches if either does (`0 9 1 * 1` is the 1st and every
 * Monday). When one does (`*` or `*\/2`), a date must match both, so
 * `0 9 * * 1` is Mondays and `0 9 *\/2 * 1` is Mondays on odd days. A day of
 * month past a month's end never matches that month, as in cron (unlike the
 * monthly cadence, which runs on the last day).
 *
 * Quartz's `L`, `W` and `#` are read too, with Quartz's meanings but cron's
 * weekday numbers (5 is Friday, 0 and 7 Sunday). In the day of month: `L` is
 * the month's last day, `L-3` three days before it, `15W` the weekday (Monday
 * to Friday) nearest the 15th and `LW` the month's last weekday. `W` never
 * leaves the month: a Saturday 1st runs on Monday the 3rd, and a Sunday that
 * is the month's last day runs on the Friday before; a `31W` doesn't run in a
 * shorter month. In the day of week: `5L` is the month's last Friday and
 * `5#3` its third (`#` takes 1 to 5; a month with no fifth Friday doesn't run
 * `5#5`). Each stands alone, with no range or step, but may sit in a list
 * with others (`1#1,1#3` is the first and third Monday), which Quartz itself
 * doesn't allow. A bare `L` in the day of week (Quartz's Saturday) is refused:
 * it reads like "last", and cron numbers the week differently. These only
 * choose dates; the times, and how a clock change moves them, are as for
 * every other rule.
 */

export const CRON_EXPR_MAX = 200;

/** A parsed rule. Every list is sorted with no repeats; weekdays are 0-6 with 0 = Sunday (a 7 is read as 0). */
export interface CronSpec {
  minutes: number[];
  hours: number[];
  monthDays: number[];
  months: number[];
  weekdays: number[];
  /** The day-of-month field starts with `*`. */
  monthDayStar: boolean;
  /** The day-of-week field starts with `*`. */
  weekdayStar: boolean;
  /** Days before the month's last day: `L` is 0, `L-3` is 3. */
  lastDays: number[];
  /** `LW`: the month's last weekday. */
  lastWeekday: boolean;
  /** `15W`: the weekday nearest each of these days of the month. */
  nearestWeekdays: number[];
  /** `5L`: the month's last of each of these weekdays. */
  lastWeekdays: number[];
  /** `5#3`: the `nth` (1-5) `weekday` of the month, sorted by weekday then nth. */
  nthWeekdays: { weekday: number; nth: number }[];
}

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

interface FieldDef {
  name: string;
  min: number;
  max: number;
  /** Names for the values from `min` up, lower case. */
  names?: string[];
}

const FIELDS: FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  { name: 'day of week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];

const MONTH_DAY_FIELD = FIELDS[2]!;
const WEEKDAY_FIELD = FIELDS[4]!;

/** The most days each month can have, February's 29 included. */
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The rule as stored: trimmed, single spaces, a shortcut in lower case. */
export function normaliseCron(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.startsWith('@') ? trimmed.toLowerCase() : trimmed;
}

function fieldValue(token: string, def: FieldDef): number | string {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return n >= def.min && n <= def.max ? n : `The ${def.name} field's "${token}" is out of range: ${def.min} to ${def.max}.`;
  }
  const index = def.names?.indexOf(token.toLowerCase()) ?? -1;
  if (index >= 0) return def.min + index;
  return `The ${def.name} field's "${token}" isn't a number${def.names ? ' or a name' : ''}.`;
}

/** One field's values, or a message naming what's wrong. */
function parseField(text: string, def: FieldDef): number[] | string {
  const values = new Set<number>();
  for (const item of text.split(',')) {
    if (item === '') return `The ${def.name} field has an empty item.`;
    const [range = '', stepText, extra] = item.split('/');
    if (extra !== undefined) return `The ${def.name} field's "${item}" has more than one "/".`;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) return `The ${def.name} field's step in "${item}" must be a whole number from 1.`;
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = def.min;
      hi = def.max;
    } else {
      const ends = range.split('-');
      if (ends.length > 2 || ends.some((e) => e === '')) return `The ${def.name} field's "${item}" isn't a value, a range or "*".`;
      const a = fieldValue(ends[0]!, def);
      if (typeof a === 'string') return a;
      const b = ends.length === 2 ? fieldValue(ends[1]!, def) : stepText !== undefined ? def.max : a;
      if (typeof b === 'string') return b;
      if (a > b) return `The ${def.name} field's range "${range}" runs backwards.`;
      lo = a;
      hi = b;
    }
    for (let v = lo; v <= hi; v += step) values.add(def === WEEKDAY_FIELD && v === 7 ? 0 : v);
  }
  return [...values].sort((x, y) => x - y);
}

/** The `L`/`W` part of a day-of-month field. */
type MonthDayExtras = Pick<CronSpec, 'lastDays' | 'lastWeekday' | 'nearestWeekdays'>;
/** The `L`/`#` part of a day-of-week field. */
type WeekdayExtras = Pick<CronSpec, 'lastWeekdays' | 'nthWeekdays'>;

/** A field's plain items, joined back with commas ('' for none) for `parseField`, and its `L`/`W`/`#` items. */
interface Split<T> {
  plain: string;
  extras: T;
}

const sortedUnique = (values: number[]): number[] => [...new Set(values)].sort((a, b) => a - b);

/** Splits a day-of-month field, or says what's wrong. The field has no names, so any `L` or `W` is one of Quartz's. */
function splitMonthDays(text: string): Split<MonthDayExtras> | string {
  const field = `The ${MONTH_DAY_FIELD.name} field`;
  const plain: string[] = [];
  const lastDays: number[] = [];
  const nearest: number[] = [];
  let lastWeekday = false;
  for (const item of text.split(',')) {
    if (item === '') return `${field} has an empty item.`;
    if (item.includes('#')) return `${field}'s "${item}" uses "#", which belongs in the day of week field ("5#3" is the third Friday).`;
    if (!/[lw]/i.test(item)) {
      plain.push(item);
      continue;
    }
    const back = /^l-(\d+)$/i.exec(item);
    const near = /^(\d+)w$/i.exec(item);
    if (/^l$/i.test(item)) lastDays.push(0);
    else if (/^lw$/i.test(item)) lastWeekday = true;
    else if (back) {
      const n = Number(back[1]);
      if (n < 1 || n > 30) return `${field}'s "${item}" is out of range: L-1 to L-30.`;
      lastDays.push(n);
    } else if (near) {
      const n = Number(near[1]);
      if (n < MONTH_DAY_FIELD.min || n > MONTH_DAY_FIELD.max) return `${field}'s "${item}" is out of range: ${MONTH_DAY_FIELD.min} to ${MONTH_DAY_FIELD.max}.`;
      nearest.push(n);
    } else if (/[/-]/.test(item)) {
      return `${field}'s "${item}" can't take a step or a range: "L", "L-3", "LW" and "15W" stand alone.`;
    } else {
      return `${field}'s "${item}" isn't a day, "L", "L-3", "LW" or a day with "W" such as "15W".`;
    }
  }
  return { plain: plain.join(','), extras: { lastDays: sortedUnique(lastDays), lastWeekday, nearestWeekdays: sortedUnique(nearest) } };
}

/** Splits a day-of-week field, or says what's wrong. No weekday name has an `l` in it, so any `L` is Quartz's. */
function splitWeekdays(text: string): Split<WeekdayExtras> | string {
  const field = `The ${WEEKDAY_FIELD.name} field`;
  const alone = `can't take a step or a range: "5L" and "5#3" stand alone.`;
  const plain: string[] = [];
  const last: number[] = [];
  const nth = new Map<string, { weekday: number; nth: number }>();
  const day = (token: string): number | string => {
    const value = fieldValue(token, WEEKDAY_FIELD);
    return value === 7 ? 0 : value;
  };
  for (const item of text.split(',')) {
    if (item === '') return `${field} has an empty item.`;
    if (/^(\d+|l)w$/i.test(item)) return `${field}'s "${item}" uses "W", which belongs in the day of month field ("15W" is the weekday nearest the 15th).`;
    if (item.includes('#')) {
      const m = /^([a-z0-9]+)#(\d+)$/i.exec(item);
      if (!m) return /[/-]/.test(item) ? `${field}'s "${item}" ${alone}` : `${field}'s "${item}" isn't a day with "#", such as "5#3" for the third Friday.`;
      const weekday = day(m[1]!);
      if (typeof weekday === 'string') return weekday;
      const k = Number(m[2]);
      if (k < 1 || k > 5) return `${field}'s "${item}" asks for week ${k}: "#" takes 1 to 5.`;
      nth.set(`${weekday}#${k}`, { weekday, nth: k });
    } else if (/l/i.test(item)) {
      if (/^l$/i.test(item)) return `${field}'s "${item}" needs a day before it, such as "5L" for the last Friday.`;
      const m = /^([a-z0-9]+)l$/i.exec(item);
      if (!m) return /[/-]/.test(item) ? `${field}'s "${item}" ${alone}` : `${field}'s "${item}" isn't a day with "L", such as "5L" for the last Friday.`;
      const weekday = day(m[1]!);
      if (typeof weekday === 'string') return weekday;
      last.push(weekday);
    } else {
      plain.push(item);
    }
  }
  const nthWeekdays = [...nth.values()].sort((a, b) => a.weekday - b.weekday || a.nth - b.nth);
  return { plain: plain.join(','), extras: { lastWeekdays: sortedUnique(last), nthWeekdays } };
}

/** A field's plain values: none for a field of only `L`/`W`/`#` items. */
function plainValues(text: string, def: FieldDef): number[] | string {
  return text === '' ? [] : parseField(text, def);
}

/**
 * Whether some date in the rule's months matches it. Each month comes in
 * every length it can have, starting on every day of the week, somewhere in
 * the calendar and within the years `nextRunAt` walks, so trying each of
 * those is exact. At most 12 x 2 x 7 x 31 checks; a rule that can run stops
 * at its first match.
 */
function canRun(spec: CronSpec): boolean {
  for (const month of spec.months) {
    for (const length of month === 2 ? [28, 29] : [MONTH_MAX_DAYS[month - 1]!]) {
      for (let first = 0; first < 7; first++) {
        for (let day = 1; day <= length; day++) {
          if (cronMatchesDate(spec, month, day, (first + day - 1) % 7, length)) return true;
        }
      }
    }
  }
  return false;
}

/** The rule, or a plain message saying what's wrong with it. A rule that can never run (`0 0 30 2 *`) is refused. */
export function parseCron(text: string): CronSpec | string {
  let expr = normaliseCron(text);
  if (expr === '') return 'Write a cron rule: minute, hour, day of month, month and day of week.';
  if (expr.length > CRON_EXPR_MAX) return `A cron rule can be at most ${CRON_EXPR_MAX} characters.`;
  if (expr.startsWith('@')) {
    if (expr === '@reboot') return "@reboot isn't supported: a schedule runs at set times.";
    const alias = ALIASES[expr];
    if (alias === undefined) return `"${expr}" isn't a shortcut OtherBench knows. Use @hourly, @daily, @weekly, @monthly or @yearly.`;
    expr = alias;
  }
  const parts = expr.split(' ');
  if (parts.length === 6) return "A cron rule here has five fields (minute, hour, day of month, month, day of week); seconds aren't supported.";
  if (parts.length !== 5) return `A cron rule has five fields (minute, hour, day of month, month, day of week); this has ${parts.length}.`;
  const [minuteText, hourText, monthDayText, monthText, weekdayText] = parts as [string, string, string, string, string];
  // Fields are checked in order, so the first one with a problem is the one named.
  const minutes = parseField(minuteText, FIELDS[0]!);
  if (typeof minutes === 'string') return minutes;
  const hours = parseField(hourText, FIELDS[1]!);
  if (typeof hours === 'string') return hours;
  const monthDaySplit = splitMonthDays(monthDayText);
  if (typeof monthDaySplit === 'string') return monthDaySplit;
  const monthDays = plainValues(monthDaySplit.plain, MONTH_DAY_FIELD);
  if (typeof monthDays === 'string') return monthDays;
  const months = parseField(monthText, FIELDS[3]!);
  if (typeof months === 'string') return months;
  const weekdaySplit = splitWeekdays(weekdayText);
  if (typeof weekdaySplit === 'string') return weekdaySplit;
  const weekdays = plainValues(weekdaySplit.plain, WEEKDAY_FIELD);
  if (typeof weekdays === 'string') return weekdays;
  const spec: CronSpec = {
    minutes,
    hours,
    monthDays,
    months,
    weekdays,
    monthDayStar: monthDayText.startsWith('*'),
    weekdayStar: weekdayText.startsWith('*'),
    ...monthDaySplit.extras,
    ...weekdaySplit.extras,
  };
  if (!canRun(spec)) {
    const quartz = spec.lastDays.length > 0 || spec.lastWeekday || spec.nearestWeekdays.length > 0 || spec.lastWeekdays.length > 0 || spec.nthWeekdays.length > 0;
    // Without L, W or #, only the day of month can rule out every date, so the plainer message says why.
    return quartz ? 'It never runs: no date in those months fits both the day of month and the day of week.' : 'It never runs: none of those months has any of those days.';
  }
  return spec;
}

/**
 * The weekday (Monday to Friday) nearest `day` in a month of `length` days,
 * where `weekday` is `day`'s day of the week; null when the month has no such
 * day. Quartz's `W`: a Saturday moves to the Friday before unless that is in
 * the month before (then the Monday after), and a Sunday to the Monday after
 * unless that is in the next month (then the Friday before).
 */
function nearestWeekday(day: number, weekday: number, length: number): number | null {
  if (day > length) return null;
  if (weekday === 6) return day === 1 ? 3 : day - 1;
  if (weekday === 0) return day === length ? day - 2 : day + 1;
  return day;
}

/**
 * Whether the rule runs on this date. `weekday` is its day of the week,
 * 0 = Sunday, and `length` the number of days in its month, for `L`, `W`
 * and `#`.
 */
export function cronMatchesDate(spec: CronSpec, month: number, day: number, weekday: number, length: number): boolean {
  if (!spec.months.includes(month)) return false;
  const weekdayOf = (d: number): number => (((weekday + d - day) % 7) + 7) % 7;
  const byMonthDay =
    spec.monthDays.includes(day) ||
    spec.lastDays.some((back) => day === length - back) ||
    (spec.lastWeekday && day === nearestWeekday(length, weekdayOf(length), length)) ||
    spec.nearestWeekdays.some((d) => day === nearestWeekday(d, weekdayOf(d), length));
  const byWeekday =
    spec.weekdays.includes(weekday) ||
    (spec.lastWeekdays.includes(weekday) && day + 7 > length) ||
    spec.nthWeekdays.some((n) => n.weekday === weekday && Math.ceil(day / 7) === n.nth);
  // A plain `*` holds every value, so with one, "both" comes down to the other field.
  return spec.monthDayStar || spec.weekdayStar ? byMonthDay && byWeekday : byMonthDay || byWeekday;
}

/** The rule's times of day in minutes from midnight, ascending. */
export function cronMinutesOfDay(spec: CronSpec): number[] {
  return spec.hours.flatMap((h) => spec.minutes.map((m) => h * 60 + m));
}
