import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../desktop/bridge.js', () => ({ openInBrowser: vi.fn(async () => {}) }));

import { openInBrowser } from '../desktop/bridge.js';
import { ViewerContext } from '../viewer/ViewerContext.js';
import { MarkdownBody } from './MarkdownBody.js';

afterEach(() => {
  cleanup();
  vi.mocked(openInBrowser).mockClear();
});

const inChat = (text: string) => {
  const actions = { openPath: vi.fn(), openArtifact: vi.fn() };
  render(
    <ViewerContext.Provider value={actions}>
      <MarkdownBody text={text} />
    </ViewerContext.Provider>
  );
  return actions;
};

describe('MarkdownBody in a chat', () => {
  it("opens a file:// link in the chat's viewer", async () => {
    const actions = inChat('See [the log](file:///C:/ws/logs/run%201.txt).');
    await userEvent.setup().click(screen.getByRole('link', { name: 'the log' }));
    expect(actions.openPath).toHaveBeenCalledWith('C:/ws/logs/run 1.txt');
  });

  it('opens a website in the default browser, never inside OtherBench', async () => {
    const actions = inChat('See [the site](https://example.com/a).');
    await userEvent.setup().click(screen.getByRole('link', { name: 'the site' }));
    expect(openInBrowser).toHaveBeenCalledWith('https://example.com/a');
    expect(actions.openPath).not.toHaveBeenCalled();
  });
  it('makes inline code that looks like a path a button, but leaves a fenced block alone, language or not', () => {
    inChat('Open `src/app.ts` now.\n\n```\nsrc/other.ts\n```\n');
    expect(screen.getByRole('button', { name: 'src/app.ts' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'src/other.ts' })).toBeNull();
    expect(screen.getByText('src/other.ts')).toBeInTheDocument();
  });
});

describe('MarkdownBody outside a chat', () => {
  it('still opens a website in the default browser rather than navigating the app away, and leaves mailto: alone', async () => {
    render(<MarkdownBody text={'[x](https://example.com) [mail](mailto:a@example.com)'} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'x' }));
    expect(openInBrowser).toHaveBeenCalledWith('https://example.com');
    expect(screen.getByRole('link', { name: 'mail' })).toHaveAttribute('href', 'mailto:a@example.com');
  });
});

describe('MarkdownBody lists', () => {
  it("wraps its output in .markdown-body, where index.css restores list markers, and passes an ordered list's start through", () => {
    const { container } = render(<MarkdownBody text={'3. Third\n4. Fourth\n\n- one\n- [ ] todo\n- [x] done\n'} />);
    const body = container.firstElementChild!;
    expect(body.classList.contains('markdown-body')).toBe(true);
    expect(body.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(body.querySelectorAll('ol > li')).toHaveLength(2);
    // A task-list item is the class index.css leaves unmarked (it shows a checkbox instead).
    const tasks = body.querySelectorAll('li.task-list-item');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(body.querySelector('ul > li:not(.task-list-item)')?.textContent).toBe('one');
  });
});

describe('MarkdownBody without remote images', () => {
  it('remoteImages false renders alt text, no img', () => {
    const { container } = render(<MarkdownBody text={'See ![diagram](https://example.com/d.png) here.'} remoteImages={false} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('[image: diagram]')).toBeInTheDocument();
  });
});
