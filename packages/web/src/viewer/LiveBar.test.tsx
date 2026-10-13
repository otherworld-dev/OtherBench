import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveOutcome, LiveStatus } from '../state/api.js';
import { describeParam, LiveBar } from './LiveBar.js';

afterEach(cleanup);

const status = (state: 'allowed' | 'needs_ok' | 'unavailable' = 'needs_ok', over: Partial<LiveStatus> = {}): LiveStatus => ({
  machine: { id: 'n1', name: 'Desk' },
  runsOn: null,
  profile: { id: 'p', name: 'Sonnet' },
  calls: [
    {
      callId: 'value', tool: 'mcp__Live__lookup', serverName: 'Live', toolName: 'lookup', description: 'Looks up a value.', state,
      ...(state === 'unavailable' ? { reason: 'MCP server "Live" isn\'t connected.' } : {}),
      args: { key: { $param: 'key' } }, params: { key: { enum: ['a', 'b'], default: 'a' } },
    },
  ],
  ...over,
});
const handlers = () => ({ onAllow: vi.fn(), onNotNow: vi.fn(), onRefresh: vi.fn(), onStop: vi.fn() });
const none = new Map<string, LiveOutcome>();

describe('LiveBar', () => {
  it('lists each call with its args, params and description, names the machine and profile, and says what the page could still do', () => {
    render(<LiveBar status={status()} error={null} hidden={false} latest={null} outcomes={none} {...handlers()} />);
    const panel = screen.getByRole('region', { name: 'Live data' });
    expect(panel).toHaveTextContent('Live · lookup');
    expect(panel).toHaveTextContent('{"key":{"$param":"key"}}');
    expect(panel).toHaveTextContent('key: a, b (default a)');
    expect(panel).toHaveTextContent('Looks up a value.');
    expect(panel).toHaveTextContent("They run on this machine (Desk) with the chat's profile (Sonnet).");
    expect(panel).toHaveTextContent('could still send what it shows elsewhere by leaving the page');
    expect(panel).not.toHaveTextContent('live data still comes from this machine');
  });

  it('says live data still comes from this machine when the chat runs on another', () => {
    render(<LiveBar status={status('needs_ok', { runsOn: { id: 'n2', name: 'Laptop' } })} error={null} hidden={false} latest={null} outcomes={none} {...handlers()} />);
    expect(screen.getByRole('region', { name: 'Live data' })).toHaveTextContent('This chat runs on Laptop; live data still comes from this machine.');
  });

  it('describes a whole-number param by its range', () => {
    expect(describeParam('days', { type: 'integer', minimum: 1, maximum: 30, default: 7 })).toBe('days: 1–30 (default 7)');
  });

  it('Allow and Not now call their handlers', async () => {
    const h = handlers();
    render(<LiveBar status={status()} error={null} hidden={false} latest={null} outcomes={none} {...h} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Allow live data' }));
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(h.onAllow).toHaveBeenCalledOnce();
    expect(h.onNotNow).toHaveBeenCalledOnce();
  });

  it('with no eligible calls shows only the reasons, and no Allow', () => {
    render(<LiveBar status={status('unavailable')} error={null} hidden={false} latest={null} outcomes={none} {...handlers()} />);
    expect(screen.getByRole('region', { name: 'Live data' })).toHaveTextContent('MCP server "Live" isn\'t connected.');
    expect(screen.queryByRole('button', { name: 'Allow live data' })).toBeNull();
  });

  it('cuts long args at 300 characters, with Show all', async () => {
    const long = status();
    long.calls[0]!.args = { blob: 'x'.repeat(400) };
    render(<LiveBar status={long} error={null} hidden={false} latest={null} outcomes={none} {...handlers()} />);
    const panel = screen.getByRole('region', { name: 'Live data' });
    expect(panel).not.toHaveTextContent('x'.repeat(390));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show all' }));
    expect(panel).toHaveTextContent('x'.repeat(400));
  });

  it('when allowed, shows the strip with the time, (cached) and failed calls, with Refresh and Stop', async () => {
    const h = handlers();
    const at = new Date(2026, 9, 12, 14, 2, 11).getTime();
    const outcomes = new Map<string, LiveOutcome>([['value', { ok: false, code: 'timeout', message: 'too slow' }]]);
    render(<LiveBar status={status('allowed')} error={null} hidden={false} latest={{ at, cached: true }} outcomes={outcomes} {...h} />);
    const strip = screen.getByRole('region', { name: 'Live data' });
    expect(strip).toHaveTextContent(`Live data · updated ${new Date(at).toLocaleTimeString()} (cached)`);
    expect(strip).toHaveTextContent('value: too slow');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await user.click(screen.getByRole('button', { name: 'Stop live data' }));
    expect(h.onRefresh).toHaveBeenCalledOnce();
    expect(h.onStop).toHaveBeenCalledOnce();
  });

  it('shows an error above the strip and the panel, keeping their buttons', async () => {
    const h = handlers();
    render(<LiveBar status={status('allowed')} error="Couldn't stop live data." hidden={false} latest={null} outcomes={none} {...h} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Live data: Couldn't stop live data.");
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await user.click(screen.getByRole('button', { name: 'Stop live data' }));
    expect(h.onRefresh).toHaveBeenCalledOnce();
    expect(h.onStop).toHaveBeenCalledOnce();
    cleanup();

    render(<LiveBar status={status()} error="Couldn't allow live data." hidden={false} latest={null} outcomes={none} {...h} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Live data: Couldn't allow live data.");
    await user.click(screen.getByRole('button', { name: 'Allow live data' }));
    expect(h.onAllow).toHaveBeenCalledOnce();
  });

  it('shows nothing once hidden, and an error when the status failed', () => {
    const { container } = render(<LiveBar status={status()} error={null} hidden latest={null} outcomes={none} {...handlers()} />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    render(<LiveBar status={null} error="Version not found." hidden={false} latest={null} outcomes={none} {...handlers()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Live data: Version not found.');
  });
});
