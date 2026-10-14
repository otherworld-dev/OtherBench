import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPUTER_DESKTOP_ONLY_REASON } from '@grunt/core/domain/computer-apps.js';
import type { ApprovalRequest } from '@grunt/core/ports/tool-provider.js';
import { ApprovalPrompt } from '../components/ApprovalPrompt.js';
import { ApiError } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { answerErrorText, DesktopOnlyNote } from './desktopOnly.js';

const request: ApprovalRequest = {
  id: 'req-1',
  chatId: 'chat-1',
  messageId: 'msg-1',
  toolName: 'computer',
  risk: 'mutate',
  source: 'computer',
  args: {
    action: 'left_click',
    coordinate: [1, 2],
    app: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
    appRisk: 'normal',
    appShellView: false,
    appWindow: 'w',
    appPid: 1,
    appStarted: 't',
  },
  summary: '',
};

describe('answers while the computer is in control', () => {
  afterEach(() => {
    cleanup();
    useGruntStore.setState({ computerSessions: {} });
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  it("shows the server's own words when it refused an answer for not coming from the desktop app, and the usual line otherwise", () => {
    expect(answerErrorText(new ApiError(403, COMPUTER_DESKTOP_ONLY_REASON), 'fallback')).toBe(COMPUTER_DESKTOP_ONLY_REASON);
    expect(answerErrorText(new ApiError(403, 'Refused: another site'), 'fallback')).toBe('fallback');
    expect(answerErrorText(new ApiError(500, COMPUTER_DESKTOP_ONLY_REASON), 'fallback')).toBe('fallback');
    expect(answerErrorText(new Error(COMPUTER_DESKTOP_ONLY_REASON), 'fallback')).toBe('fallback');
  });

  it('says so on a card in a browser while a chat controls the computer, and not in the desktop app or when nothing does', () => {
    render(<DesktopOnlyNote />);
    expect(screen.queryByTestId('desktop-only-note')).toBeNull();
    cleanup();
    useGruntStore.setState({ computerSessions: { 'chat-9': {} } });
    render(<DesktopOnlyNote />);
    expect(screen.getByTestId('desktop-only-note')).toHaveTextContent('Grunt is controlling this computer. Until that ends, answer this in the Grunt app on this computer.');
    cleanup();
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    render(<DesktopOnlyNote />);
    expect(screen.queryByTestId('desktop-only-note')).toBeNull();
  });

  it("puts the note and the server's refusal on an approval card", async () => {
    useGruntStore.setState({ computerSessions: { 'chat-1': {} } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onResolve = vi.fn().mockRejectedValue(new ApiError(403, COMPUTER_DESKTOP_ONLY_REASON));
    render(<ApprovalPrompt request={request} onResolve={onResolve} />);
    expect(screen.getByTestId('desktop-only-note')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Allow once' }));
    expect(await screen.findByText(COMPUTER_DESKTOP_ONLY_REASON)).toBeInTheDocument();
    spy.mockRestore();
  });
});
