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
    for (let v = lo; v <= hi; v += step) values.add(def.name === 'day of week' && v === 7 ? 0 : v);
  }
  return [...values].sort((x, y) => x - y);
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
  const lists: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const values = parseField(parts[i]!, FIELDS[i]!);
    if (typeof values === 'string') return values;
    lists.push(values);
  }
  const [minutes, hours, monthDays, months, weekdays] = lists as [number[], number[], number[], number[], number[]];
  const spec: CronSpec = {
    minutes,
    hours,
    monthDays,
    months,
    weekdays,
    monthDayStar: parts[2]!.startsWith('*'),
    weekdayStar: parts[4]!.startsWith('*'),
  };
  // Only the day of month can rule out every date. With the either-field rule a day of week always finds one;
  // otherwise any month and day that exist come round on every day of the week within the years `nextRunAt` walks.
  const eitherField = !spec.monthDayStar && !spec.weekdayStar;
  if (!eitherField && !months.some((m) => monthDays.some((d) => d <= MONTH_MAX_DAYS[m - 1]!))) {
    return 'It never runs: none of those months has any of those days.';
  }
  return spec;
}

/** Whether the rule runs on this date; `weekday` is its day of the week, 0 = Sunday. */
export function cronMatchesDate(spec: CronSpec, month: number, day: number, weekday: number): boolean {
  if (!spec.months.includes(month)) return false;
  const byMonthDay = spec.monthDays.includes(day);
  const byWeekday = spec.weekdays.includes(weekday);
  // A plain `*` holds every value, so with one, "both" comes down to the other field.
  return spec.monthDayStar || spec.weekdayStar ? byMonthDay && byWeekday : byMonthDay || byWeekday;
}

/** The rule's times of day in minutes from midnight, ascending. */
export function cronMinutesOfDay(spec: CronSpec): number[] {
  return spec.hours.flatMap((h) => spec.minutes.map((m) => h * 60 + m));
}
