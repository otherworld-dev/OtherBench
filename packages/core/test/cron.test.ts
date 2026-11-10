import { describe, expect, it } from 'vitest';
import { cronMatchesDate, cronMinutesOfDay, normaliseCron, parseCron, type CronSpec } from '../src/domain/cron.js';

const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

function spec(text: string): CronSpec {
  const s = parseCron(text);
  if (typeof s === 'string') throw new Error(s);
  return s;
}

describe('parseCron', () => {
  it('reads the five fields with *, lists, ranges, steps and names', () => {
    expect(spec('0 9 * * 1-5')).toEqual({
      minutes: [0],
      hours: [9],
      monthDays: range(1, 31),
      months: range(1, 12),
      weekdays: [1, 2, 3, 4, 5],
      monthDayStar: true,
      weekdayStar: false,
      lastDays: [],
      lastWeekday: false,
      nearestWeekdays: [],
      lastWeekdays: [],
      nthWeekdays: [],
    });
    const s = spec('*/15 0-6/2,12 1,15 jan-MAR,dec sun,7');
    expect(s.minutes).toEqual([0, 15, 30, 45]);
    expect(s.hours).toEqual([0, 2, 4, 6, 12]);
    expect(s.monthDays).toEqual([1, 15]);
    expect(s.months).toEqual([1, 2, 3, 12]);
    expect(s.weekdays).toEqual([0]);
    expect(s.monthDayStar).toBe(false);
    expect(s.weekdayStar).toBe(false);
  });

  it('runs a start with a step to the end of the field, and reads 7 as Sunday', () => {
    expect(spec('5/20 * * * *').minutes).toEqual([5, 25, 45]);
    expect(spec('0 0 * * 5-7').weekdays).toEqual([0, 5, 6]);
    expect(spec('0 0 * * */2').weekdays).toEqual([0, 2, 4, 6]);
  });

  it('takes the shortcuts, in any case', () => {
    expect(spec('@daily')).toEqual(spec('0 0 * * *'));
    expect(spec('@midnight')).toEqual(spec('0 0 * * *'));
    expect(spec('@HOURLY')).toEqual(spec('0 * * * *'));
    expect(spec('@weekly')).toEqual(spec('0 0 * * 0'));
    expect(spec('@monthly')).toEqual(spec('0 0 1 * *'));
    expect(spec('@yearly')).toEqual(spec('0 0 1 1 *'));
    expect(spec('@annually')).toEqual(spec('0 0 1 1 *'));
  });

  it('says plainly what is wrong', () => {
    expect(parseCron('  ')).toBe('Write a cron rule: minute, hour, day of month, month and day of week.');
    expect(parseCron('0 9 * *')).toBe('A cron rule has five fields (minute, hour, day of month, month, day of week); this has 4.');
    expect(parseCron('0 0 9 * * *')).toBe("A cron rule here has five fields (minute, hour, day of month, month, day of week); seconds aren't supported.");
    expect(parseCron('60 * * * *')).toBe('The minute field\'s "60" is out of range: 0 to 59.');
    expect(parseCron('0 24 * * *')).toBe('The hour field\'s "24" is out of range: 0 to 23.');
    expect(parseCron('0 0 0 * *')).toBe('The day of month field\'s "0" is out of range: 1 to 31.');
    expect(parseCron('0 0 * 13 *')).toBe('The month field\'s "13" is out of range: 1 to 12.');
    expect(parseCron('0 0 * * 8')).toBe('The day of week field\'s "8" is out of range: 0 to 7.');
    expect(parseCron('0 0 * foo *')).toBe('The month field\'s "foo" isn\'t a number or a name.');
    expect(parseCron('x 0 * * *')).toBe('The minute field\'s "x" isn\'t a number.');
    expect(parseCron('0 0 * * mon-')).toBe('The day of week field\'s "mon-" isn\'t a value, a range or "*".');
    expect(parseCron('5-1 * * * *')).toBe('The minute field\'s range "5-1" runs backwards.');
    expect(parseCron('*/0 * * * *')).toBe('The minute field\'s step in "*/0" must be a whole number from 1.');
    expect(parseCron('1/2/3 * * * *')).toBe('The minute field\'s "1/2/3" has more than one "/".');
    expect(parseCron('1,,2 * * * *')).toBe('The minute field has an empty item.');
    expect(parseCron('@reboot')).toBe("@reboot isn't supported: a schedule runs at set times.");
    expect(parseCron('@every')).toBe('"@every" isn\'t a shortcut OtherBench knows. Use @hourly, @daily, @weekly, @monthly or @yearly.');
    expect(parseCron(`0 0 * * * ${'x'.repeat(200)}`)).toBe('A cron rule can be at most 200 characters.');
  });

  it('reads L, L-n, LW and nW in the day of month, and nL and n#k in the day of week (Quartz)', () => {
    const days = spec('0 9 L,L-2,lw,15W,1 * *');
    expect(days.monthDays).toEqual([1]);
    expect(days.lastDays).toEqual([0, 2]);
    expect(days.lastWeekday).toBe(true);
    expect(days.nearestWeekdays).toEqual([15]);
    expect(days.monthDayStar).toBe(false);
    const weekdays = spec('0 9 * * 5L,fri#3,1#1,7l,2');
    expect(weekdays.weekdays).toEqual([2]);
    expect(weekdays.lastWeekdays).toEqual([0, 5]);
    expect(weekdays.nthWeekdays).toEqual([
      { weekday: 1, nth: 1 },
      { weekday: 5, nth: 3 },
    ]);
    expect(weekdays.weekdayStar).toBe(false);
  });

  it('says plainly what is wrong with L, W and #', () => {
    expect(parseCron('0 0 L/2 * *')).toBe('The day of month field\'s "L/2" can\'t take a step or a range: "L", "L-3", "LW" and "15W" stand alone.');
    expect(parseCron('0 0 1-5W * *')).toBe('The day of month field\'s "1-5W" can\'t take a step or a range: "L", "L-3", "LW" and "15W" stand alone.');
    expect(parseCron('0 0 5L * *')).toBe('The day of month field\'s "5L" isn\'t a day, "L", "L-3", "LW" or a day with "W" such as "15W".');
    expect(parseCron('0 0 32W * *')).toBe('The day of month field\'s "32W" is out of range: 1 to 31.');
    expect(parseCron('0 0 L-31 * *')).toBe('The day of month field\'s "L-31" is out of range: L-1 to L-30.');
    expect(parseCron('0 0 5#3 * *')).toBe('The day of month field\'s "5#3" uses "#", which belongs in the day of week field ("5#3" is the third Friday).');
    expect(parseCron('0 0 * * 15W')).toBe('The day of week field\'s "15W" uses "W", which belongs in the day of month field ("15W" is the weekday nearest the 15th).');
    expect(parseCron('0 0 * * L')).toBe('The day of week field\'s "L" needs a day before it, such as "5L" for the last Friday.');
    expect(parseCron('0 0 * * 5#6')).toBe('The day of week field\'s "5#6" asks for week 6: "#" takes 1 to 5.');
    expect(parseCron('0 0 * * 5#0')).toBe('The day of week field\'s "5#0" asks for week 0: "#" takes 1 to 5.');
    expect(parseCron('0 0 * * 8#1')).toBe('The day of week field\'s "8" is out of range: 0 to 7.');
    expect(parseCron('0 0 * * 1-5L')).toBe('The day of week field\'s "1-5L" can\'t take a step or a range: "5L" and "5#3" stand alone.');
    expect(parseCron('0 0 * * 5#3/2')).toBe('The day of week field\'s "5#3/2" can\'t take a step or a range: "5L" and "5#3" stand alone.');
    expect(parseCron('0 0 * * wed')).not.toBeTypeOf('string');
    expect(parseCron('0 0 * jul *')).not.toBeTypeOf('string');
  });

  it('refuses an L, W or # rule that can never run', () => {
    const never = 'It never runs: no date in those months fits both the day of month and the day of week.';
    expect(parseCron('0 0 30W 2 *')).toBe(never);
    expect(parseCron('0 0 */10 * 5#4')).toBe(never); // the 1st, 11th, 21st and 31st are never in a month's fourth week
    expect(typeof parseCron('0 0 * 2 5#5')).toBe('object'); // 29 February on a Friday
    expect(typeof parseCron('0 0 L 2 *')).toBe('object');
    expect(typeof parseCron('0 0 29W 2 *')).toBe('object');
    expect(typeof parseCron('0 0 30W 2 5#5')).toBe('object'); // either field: the fifth Friday rescues it
  });

  it('refuses a rule that can never run, but not one a day of week rescues', () => {
    expect(parseCron('0 0 30 2 *')).toBe('It never runs: none of those months has any of those days.');
    expect(parseCron('0 0 31 4,6,9,11 *')).toBe('It never runs: none of those months has any of those days.');
    expect(typeof parseCron('0 0 31 4,6,9,11 1')).toBe('object'); // Mondays in those months
    expect(typeof parseCron('0 0 29 2 *')).toBe('object');
    expect(typeof parseCron('0 0 31 1-12 *')).toBe('object');
  });
});

describe('normaliseCron', () => {
  it('trims, keeps single spaces and lowers a shortcut', () => {
    expect(normaliseCron('  0   9 *\t* 1-5 ')).toBe('0 9 * * 1-5');
    expect(normaliseCron(' @Daily ')).toBe('@daily');
    expect(normaliseCron('0 9 * JAN MON')).toBe('0 9 * JAN MON');
  });
});

describe('cronMatchesDate', () => {
  it('matches either field when both days are restricted (Vixie)', () => {
    const s = spec('0 9 1 * 1');
    expect(cronMatchesDate(s, 10, 1, 4, 31)).toBe(true); // Thursday 1 October
    expect(cronMatchesDate(s, 10, 5, 1, 31)).toBe(true); // Monday 5 October
    expect(cronMatchesDate(s, 10, 6, 2, 31)).toBe(false);
  });

  it('needs both when either day field starts with *', () => {
    expect(cronMatchesDate(spec('0 9 * * 1'), 10, 5, 1, 31)).toBe(true);
    expect(cronMatchesDate(spec('0 9 * * 1'), 10, 6, 2, 31)).toBe(false);
    expect(cronMatchesDate(spec('0 9 15 * *'), 10, 15, 4, 31)).toBe(true);
    expect(cronMatchesDate(spec('0 9 15 * *'), 10, 16, 5, 31)).toBe(false);
    const oddMondays = spec('0 9 */2 * 1');
    expect(cronMatchesDate(oddMondays, 10, 5, 1, 31)).toBe(true);
    expect(cronMatchesDate(oddMondays, 10, 12, 1, 31)).toBe(false);
    expect(cronMatchesDate(oddMondays, 10, 7, 3, 31)).toBe(false);
  });

  it("matches L, L-n and LW on the month's last days", () => {
    expect(cronMatchesDate(spec('0 9 L * *'), 10, 31, 6, 31)).toBe(true);
    expect(cronMatchesDate(spec('0 9 L * *'), 10, 30, 5, 31)).toBe(false);
    expect(cronMatchesDate(spec('0 9 L * *'), 2, 28, 6, 28)).toBe(true);
    expect(cronMatchesDate(spec('0 9 L * *'), 2, 28, 6, 29)).toBe(false);
    expect(cronMatchesDate(spec('0 9 L-2 * *'), 10, 29, 4, 31)).toBe(true);
    // October 2026 ends on a Saturday, January 2027 and February 2027 on a Sunday, November 2026 on a Monday.
    const lw = spec('0 9 LW * *');
    expect(cronMatchesDate(lw, 10, 30, 5, 31)).toBe(true);
    expect(cronMatchesDate(lw, 10, 31, 6, 31)).toBe(false);
    expect(cronMatchesDate(lw, 1, 29, 5, 31)).toBe(true);
    expect(cronMatchesDate(lw, 2, 26, 5, 28)).toBe(true);
    expect(cronMatchesDate(lw, 11, 30, 1, 30)).toBe(true);
  });

  it('matches nW on the weekday nearest the day, never leaving the month', () => {
    const first = spec('0 9 1W * *');
    expect(cronMatchesDate(first, 8, 3, 1, 31)).toBe(true); // 1 August 2026 is a Saturday: Monday the 3rd, not Friday 31 July
    expect(cronMatchesDate(first, 8, 1, 6, 31)).toBe(false);
    expect(cronMatchesDate(first, 11, 2, 1, 30)).toBe(true); // 1 November 2026 is a Sunday
    const mid = spec('0 9 15W * *');
    expect(cronMatchesDate(mid, 8, 14, 5, 31)).toBe(true); // Saturday the 15th: Friday the 14th
    expect(cronMatchesDate(mid, 11, 16, 1, 30)).toBe(true); // Sunday the 15th: Monday the 16th
    expect(cronMatchesDate(mid, 10, 15, 4, 31)).toBe(true);
    expect(cronMatchesDate(mid, 10, 16, 5, 31)).toBe(false);
    expect(cronMatchesDate(spec('0 9 31W * *'), 5, 29, 5, 31)).toBe(true); // Sunday 31 May 2026: Friday the 29th, not 1 June
    expect(cronMatchesDate(spec('0 9 31W * *'), 11, 30, 1, 30)).toBe(false); // November has no 31st
  });

  it('matches nL on the last such weekday and n#k on the k-th', () => {
    // Fridays in October 2026: 2, 9, 16, 23, 30. November 2026 has four.
    expect(cronMatchesDate(spec('0 9 * * 5L'), 10, 30, 5, 31)).toBe(true);
    expect(cronMatchesDate(spec('0 9 * * 5L'), 10, 23, 5, 31)).toBe(false);
    expect(cronMatchesDate(spec('0 9 * * 5#3'), 10, 16, 5, 31)).toBe(true);
    expect(cronMatchesDate(spec('0 9 * * 5#3'), 10, 9, 5, 31)).toBe(false);
    expect(cronMatchesDate(spec('0 9 * * 5#5'), 10, 30, 5, 31)).toBe(true);
    expect(cronMatchesDate(spec('0 9 * * 5#5'), 11, 27, 5, 30)).toBe(false);
    expect(cronMatchesDate(spec('0 9 * * 5#3'), 10, 15, 4, 31)).toBe(false);
  });

  it('keeps the Vixie either/both rule with the new forms', () => {
    const either = spec('0 9 L * 1#1');
    expect(cronMatchesDate(either, 10, 31, 6, 31)).toBe(true);
    expect(cronMatchesDate(either, 10, 5, 1, 31)).toBe(true);
    expect(cronMatchesDate(either, 10, 12, 1, 31)).toBe(false);
    const both = spec('0 9 */2 * 5L');
    expect(cronMatchesDate(both, 10, 30, 5, 31)).toBe(false); // the last Friday, but an even day
    expect(cronMatchesDate(both, 7, 31, 5, 31)).toBe(true); // Friday 31 July 2026
  });

  it('checks the month', () => {
    expect(cronMatchesDate(spec('0 9 * jun-aug *'), 5, 31, 0, 31)).toBe(false);
    expect(cronMatchesDate(spec('0 9 * jun-aug *'), 6, 1, 1, 30)).toBe(true);
  });
});

describe('cronMinutesOfDay', () => {
  it('lists every hour and minute pair in order', () => {
    expect(cronMinutesOfDay(spec('0,30 9-10 * * *'))).toEqual([540, 570, 600, 630]);
    expect(cronMinutesOfDay(spec('* * * * *'))).toHaveLength(1440);
  });
});
