import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../desktop/bridge.js', () => ({ openInBrowser: vi.fn(async () => {}) }));
vi.mock('../code/openDeckCard.js', () => ({ openDeckCard: vi.fn(async () => {}) }));

import { openDeckCard } from '../code/openDeckCard.js';
import { openInBrowser } from '../desktop/bridge.js';
import { ViewerContext } from '../viewer/ViewerContext.js';
import { MarkdownBody } from './MarkdownBody.js';

afterEach(() => {
  cleanup();
  vi.mocked(openInBrowser).mockClear();
  vi.mocked(openDeckCard).mockClear();
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

describe('MarkdownBody copy sections', () => {
  const reply = "I've toned it down:\n\n---\n\nHi Toni,\n\nA few things:\n\n1. **One**\n2. Two\n\nThanks, Adam\n";

  it('copies only the text under the rule, as its markdown', async () => {
    const user = userEvent.setup();
    render(<MarkdownBody text={reply} copySections />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe('Hi Toni,\n\nA few things:\n\n1. **One**\n2. Two\n\nThanks, Adam');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('gives each later section its own button, and leaves a trailing rule as a rule', () => {
    const { container } = render(<MarkdownBody text={'Intro\n\n---\n\nDraft\n\n---\n\nNote\n\n---\n'} copySections />);
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
    expect(container.querySelectorAll('hr')).toHaveLength(1);
  });

  it('without copySections a rule is just a rule', () => {
    const { container } = render(<MarkdownBody text={reply} />);
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('renders footnotes as a plain section', () => {
    render(<MarkdownBody text={'Text[^1]\n\n---\n\nMore\n\n[^1]: The note.'} copySections />);
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(1);
    expect(screen.getByText(/The note\./)).toBeInTheDocument();
  });
});

describe('MarkdownBody deck links', () => {
  it('turns Deck #967 and Deck card #12 into links', () => {
    render(<MarkdownBody text={'Fixed in Deck #967, see also deck card #12.'} deckLinks />);
    expect(screen.getByRole('link', { name: 'Deck #967' })).toHaveAttribute('href', 'deck:967');
    expect(screen.getByRole('link', { name: 'deck card #12' })).toHaveAttribute('href', 'deck:12');
  });

  it('leaves Deck #N inside code alone', () => {
    render(<MarkdownBody text={'Run `Deck #5` now.\n\n```\nDeck #6\n```\n'} deckLinks />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText('Deck #5')).toBeInTheDocument();
    expect(screen.getByText('Deck #6')).toBeInTheDocument();
  });

  it('leaves a bare #965 alone', () => {
    render(<MarkdownBody text={'Issue #965 and Decks #3.'} deckLinks />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('without deckLinks nothing changes', () => {
    render(<MarkdownBody text={'Fixed in Deck #967.'} />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText('Fixed in Deck #967.')).toBeInTheDocument();
  });

  it('clicking a deck link calls openDeckCard', async () => {
    render(<MarkdownBody text={'See Deck #967.'} deckLinks />);
    await userEvent.setup().click(screen.getByRole('link', { name: 'Deck #967' }));
    expect(openDeckCard).toHaveBeenCalledWith(967);
    expect(openInBrowser).not.toHaveBeenCalled();
  });
});
