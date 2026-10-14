import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { saveDownload, isMainWindowFocused, showNotification } = vi.hoisted(() => ({ saveDownload: vi.fn(), isMainWindowFocused: vi.fn(), showNotification: vi.fn() }));
vi.mock('../desktop/bridge.js', () => ({ saveDownload, isMainWindowFocused, showNotification }));

import { saveFile } from './saveFile.js';
import { useToasts } from './toasts.js';

const blob = new Blob(['x'], { type: 'text/plain' });
const toasts = () => useToasts.getState().toasts;

beforeEach(() => {
  useToasts.setState({ toasts: [] });
  saveDownload.mockReset();
  isMainWindowFocused.mockReset();
  showNotification.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('saveFile', () => {
  it('in the desktop app saves through the shell and toasts where it went, with Show in folder', async () => {
    saveDownload.mockResolvedValue('C:\\Users\\a\\Downloads\\budget (1).xlsx');
    isMainWindowFocused.mockResolvedValue(true);
    await saveFile(blob, 'budget.xlsx');
    expect(saveDownload).toHaveBeenCalledWith(blob, 'budget.xlsx');
    expect(toasts()).toEqual([expect.objectContaining({ tone: 'ok', text: 'Downloaded budget (1).xlsx to Downloads', path: 'C:\\Users\\a\\Downloads\\budget (1).xlsx' })]);
    // Focused: the toast is enough.
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('also raises a desktop notification that shows the file when the window is not focused', async () => {
    saveDownload.mockResolvedValue('C:\\Users\\a\\Downloads\\notes.md');
    isMainWindowFocused.mockResolvedValue(false);
    await saveFile(blob, 'notes.md');
    expect(showNotification).toHaveBeenCalledWith('Download complete', 'notes.md is in your Downloads folder. Click to show it.', null, 'C:\\Users\\a\\Downloads\\notes.md');
  });

  it('in a browser lets the browser save it and toasts the name, with no folder', async () => {
    saveDownload.mockResolvedValue(null);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    await saveFile(blob, 'chat.md');
    expect(click).toHaveBeenCalledTimes(1);
    expect(toasts()).toEqual([expect.objectContaining({ tone: 'ok', text: 'Downloaded chat.md' })]);
    expect(toasts()[0]!.path).toBeUndefined();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("never throws: a refused or failed save is an error toast saying why", async () => {
    saveDownload.mockRejectedValue(new Error("Grunt doesn't save .exe files: Windows would run them."));
    await expect(saveFile(blob, 'x.exe')).resolves.toBeUndefined();
    expect(toasts()).toEqual([expect.objectContaining({ tone: 'error', text: "Couldn't save x.exe: Grunt doesn't save .exe files: Windows would run them." })]);
    saveDownload.mockRejectedValue('Expected the file\'s bytes.');
    await saveFile(blob, 'y.md');
    expect(toasts().at(-1)).toMatchObject({ tone: 'error', text: "Couldn't save y.md: Expected the file's bytes." });
  });

  it('a notification that fails does not undo the toast or throw', async () => {
    saveDownload.mockResolvedValue('C:\\Users\\a\\Downloads\\a.md');
    isMainWindowFocused.mockResolvedValue(false);
    showNotification.mockRejectedValue(new Error('toast failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(saveFile(blob, 'a.md')).resolves.toBeUndefined();
    expect(toasts()).toHaveLength(1);
  });
});
