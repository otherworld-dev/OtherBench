import { describe, expect, it } from 'vitest';
import { ApprovalTickets, ticketKey } from '../src/tickets.js';

describe('ApprovalTickets', () => {
  it('hands each approved call its described arguments once, by tool and exact input', () => {
    const t = new ApprovalTickets();
    t.add('browser', { command: 'open', url: 'example.com' }, { host: 'example.com', n: 1 });
    t.add('browser', { command: 'open', url: 'example.com' }, { host: 'example.com', n: 2 });
    expect(t.take('browser', { command: 'open', url: 'other.test' })).toBeNull();
    expect(t.take('other', { command: 'open', url: 'example.com' })).toBeNull();
    expect(t.take('browser', { command: 'open', url: 'example.com' })).toEqual({ args: { host: 'example.com', n: 1 } });
    expect(t.take('browser', { command: 'open', url: 'example.com' })).toEqual({ args: { host: 'example.com', n: 2 } });
    expect(t.take('browser', { command: 'open', url: 'example.com' })).toBeNull();
    expect(t.size).toBe(0);
  });

  it('forgets everything on clear', () => {
    const t = new ApprovalTickets();
    t.add('browser', {}, { host: 'a' });
    t.clear();
    expect(t.take('browser', {})).toBeNull();
    expect(ticketKey('browser', undefined)).toBe(ticketKey('browser', {}));
  });
});
