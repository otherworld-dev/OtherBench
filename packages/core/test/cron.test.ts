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
    expect(cronMatchesDate(s, 10, 1, 4)).toBe(true); // Thursday 1 October
    expect(cronMatchesDate(s, 10, 5, 1)).toBe(true); // Monday 5 October
    expect(cronMatchesDate(s, 10, 6, 2)).toBe(false);
  });

  it('needs both when either day field starts with *', () => {
    expect(cronMatchesDate(spec('0 9 * * 1'), 10, 5, 1)).toBe(true);
    expect(cronMatchesDate(spec('0 9 * * 1'), 10, 6, 2)).toBe(false);
    expect(cronMatchesDate(spec('0 9 15 * *'), 10, 15, 4)).toBe(true);
    expect(cronMatchesDate(spec('0 9 15 * *'), 10, 16, 5)).toBe(false);
    const oddMondays = spec('0 9 */2 * 1');
    expect(cronMatchesDate(oddMondays, 10, 5, 1)).toBe(true);
    expect(cronMatchesDate(oddMondays, 10, 12, 1)).toBe(false);
    expect(cronMatchesDate(oddMondays, 10, 7, 3)).toBe(false);
  });

  it('checks the month', () => {
    expect(cronMatchesDate(spec('0 9 * jun-aug *'), 5, 31, 0)).toBe(false);
    expect(cronMatchesDate(spec('0 9 * jun-aug *'), 6, 1, 1)).toBe(true);
  });
});

describe('cronMinutesOfDay', () => {
  it('lists every hour and minute pair in order', () => {
    expect(cronMinutesOfDay(spec('0,30 9-10 * * *'))).toEqual([540, 570, 600, 630]);
    expect(cronMinutesOfDay(spec('* * * * *'))).toHaveLength(1440);
  });
});
