/**
 * Which of a thread's messages are drawn (`panes/Thread.tsx`). Normally a run from `start` to the end of the chat,
 * growing upwards as the reader scrolls up. Going to a message far before it (find, the outline) would make that run
 * the whole chat, and drawing a 586-message chat whole froze the window for about two seconds, so the window is cut
 * loose from the end instead: `end` (exclusive) is where it stops, and null means it runs to the end of the chat.
 */
export interface DrawnWindow {
  start: number;
  end: number | null;
}

/**
 * `win` fitted to a chat of `length` messages: never past its end, and never fewer than `size` drawn when there are
 * that many (switching to a shorter branch). A window reaching the end of the chat runs to it again.
 */
export function clampWindow(win: DrawnWindow, length: number, size: number): DrawnWindow {
  const end = win.end === null || win.end >= length ? null : win.end;
  const start = Math.max(0, Math.min(win.start, (end ?? length) - size));
  return { start, end };
}

/**
 * The window to draw so message `index` is in it. Left as it is when the message is drawn; grown to it when it's
 * within `size` of either edge, so nearby matches step along one run; else a fresh `size` messages from it, which
 * joins the end of the chat again when it would reach it.
 */
export function windowFor(win: DrawnWindow, index: number, length: number, size: number): DrawnWindow {
  const at = clampWindow(win, length, size);
  const end = at.end ?? length;
  if (index >= at.start && index < end) return at;
  if (index < at.start && at.start - index <= size) return { start: index, end: at.end };
  if (at.end !== null && index >= at.end && index - at.end < size) return clampWindow({ start: at.start, end: Math.max(at.end + size, index + 1) }, length, size);
  return clampWindow({ start: index, end: index + size }, length, size);
}
