import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanUsage } from '@otherbench/core/types/usage.js';

vi.mock('../state/api.js', () => ({ api: { claude: { planUsage: vi.fn() } } }));

import { api } from '../state/api.js';
import { formatReset, PLAN_USAGE_POLL_MS, PlanUsageMeter, usageDetails } from './PlanUsageMeter.js';

const planUsage = vi.mocked(api.claude.planUsage);
const at = (h: number, m: number, dayOffset = 0) => new Date(2026, 9, 7 + dayOffset, h, m).getTime();
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function reading(five: number, week: number): PlanUsage {
  return {
    fetchedAt: at(13, 30),
    windows: [
      { id: 'five_hour', label: '5-hour', percent: five, resetsAt: at(15, 10) },
      { id: 'seven_day', label: 'Weekly', percent: week, resetsAt: at(16, 0, 2) },
      { id: 'model:Fable', label: 'Fable weekly', percent: 0, resetsAt: null },
    ],
  };
}

/** Lets the meter's pending fetch settle. */
const settle = () => act(async () => {});

describe('PlanUsageMeter', () => {
  beforeEach(() => {
    planUsage.mockReset().mockResolvedValue({ usage: reading(7, 80) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows the 5-hour and weekly use, amber from 80% and red from 95%, with every window and reset time in its details', async () => {
    render(<PlanUsageMeter busy={false} />);
    await settle();
    const meter = screen.getByTestId('plan-usage');
    expect(meter).toHaveTextContent('5h 7% · week 80%');
    expect(screen.getByText('7%').className).toContain('text-muted');
    expect(screen.getByText('80%').className).toContain('--warn');
    expect(meter.title).toBe(usageDetails(reading(7, 80), Date.now()));
    expect(meter.title).toContain('Fable weekly: 0% used');
    expect(meter).toHaveAccessibleName(expect.stringContaining('Claude plan usage. 5-hour: 7% used'));

    planUsage.mockResolvedValue({ usage: reading(96, 50) });
    cleanup();
    render(<PlanUsageMeter busy={false} />);
    await settle();
    expect(screen.getByText('96%').className).toContain('--danger');
  });

  it("drops the 5h / week labels in a narrow composer, leaving the percentages (the tooltip still has every window)", async () => {
    render(<PlanUsageMeter busy={false} />);
    await settle();
    const label = screen.getByText('5h', { exact: false, selector: 'span span span' });
    expect(label).toHaveClass('@max-lg:hidden');
    // In a very narrow composer there's no room for it at all.
    expect(screen.getByTestId('plan-usage')).toHaveClass('@max-md:hidden');
  });

  it('shows nothing when the login has no plan', async () => {
    planUsage.mockResolvedValue({ usage: null });
    render(<PlanUsageMeter busy={false} />);
    await settle();
    expect(screen.queryByTestId('plan-usage')).not.toBeInTheDocument();
  });

  it('reads again every 5 minutes, and asks for a fresh reading when a reply finishes', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<PlanUsageMeter busy={false} />);
    await settle();
    expect(planUsage).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PLAN_USAGE_POLL_MS);
    });
    expect(planUsage).toHaveBeenCalledTimes(2);
    expect(planUsage).toHaveBeenLastCalledWith(false);

    rerender(<PlanUsageMeter busy />);
    await settle();
    expect(planUsage).toHaveBeenCalledTimes(2);
    planUsage.mockResolvedValue({ usage: reading(9, 81) });
    rerender(<PlanUsageMeter busy={false} />);
    await settle();
    expect(planUsage).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId('plan-usage')).toHaveTextContent('5h 9% · week 81%');
  });

  it('keeps the last reading when a later read fails', async () => {
    const { rerender } = render(<PlanUsageMeter busy />);
    await settle();
    planUsage.mockRejectedValue(new Error('offline'));
    rerender(<PlanUsageMeter busy={false} />);
    await settle();
    expect(screen.getByTestId('plan-usage')).toHaveTextContent('5h 7% · week 80%');
  });
});

describe('formatReset', () => {
  it('gives a time for today and a weekday and time for another day', () => {
    const now = at(13, 30);
    expect(formatReset(at(15, 10), now)).toBe(time(at(15, 10)));
    expect(formatReset(at(16, 0, 2), now)).toBe(`${new Date(at(16, 0, 2)).toLocaleDateString([], { weekday: 'short' })} ${time(at(16, 0, 2))}`);
  });
});
