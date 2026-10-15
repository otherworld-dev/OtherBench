import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Section, useSectionSummary, type SummaryTone } from './InspectorSection.js';
import { INSPECTOR_SECTIONS_STORAGE_KEY, resetInspectorSectionsForTests } from '../state/inspectorSections.js';

function Body({ text, tone }: { text: string | null; tone?: SummaryTone }): JSX.Element {
  useSectionSummary(text, tone);
  return <p>body text</p>;
}

beforeEach(() => {
  window.localStorage.clear();
  resetInspectorSectionsForTests();
});
afterEach(cleanup);

describe('Inspector Section', () => {
  it('starts closed with its summary in the header, and opens on click', async () => {
    render(
      <Section title="Tool grants">
        <Body text="3" />
      </Section>
    );
    const toggle = screen.getByRole('button', { name: 'Tool grants 3' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('body text')).not.toBeVisible();

    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('body text')).toBeVisible();
  });

  it('starts open when asked to', () => {
    render(
      <Section title="Workspace" defaultOpen>
        <Body text="Grunt" />
      </Section>
    );
    expect(screen.getByRole('button', { name: 'Workspace Grunt' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens by itself and colours the header when its body reports a problem', () => {
    render(
      <Section title="MCP servers">
        <Body text="1 needs sign-in" tone="warn" />
      </Section>
    );
    expect(screen.getByRole('button', { name: 'MCP servers 1 needs sign-in' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('1 needs sign-in')).toHaveAttribute('data-tone', 'warn');
  });

  it('stays open once the problem that opened it clears, until closed by hand', async () => {
    // Unticking a failing MCP server clears the problem from inside the open section: it mustn't shut under the pointer.
    const { rerender } = render(
      <Section title="MCP servers">
        <Body text="1 of 1 on · 1 failing" tone="danger" />
      </Section>
    );
    rerender(
      <Section title="MCP servers">
        <Body text="0 of 1 on" tone="normal" />
      </Section>
    );
    const toggle = screen.getByRole('button', { name: 'MCP servers 0 of 1 on' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('body text')).toBeVisible();

    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('remembers an explicit choice, over the default, across mounts', async () => {
    const { unmount } = render(
      <Section title="Workspace" defaultOpen>
        <Body text={null} />
      </Section>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Workspace' }));
    expect(JSON.parse(window.localStorage.getItem(INSPECTOR_SECTIONS_STORAGE_KEY)!)).toEqual({ Workspace: false });
    unmount();

    resetInspectorSectionsForTests();
    render(
      <Section title="Workspace" defaultOpen>
        <Body text={null} />
      </Section>
    );
    expect(screen.getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('a fixed section has a plain heading and no toggle', () => {
    render(
      <Section title="Project" collapsible={false}>
        <Body text="ignored" />
      </Section>
    );
    expect(screen.getByRole('heading', { name: 'Project' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('body text')).toBeVisible();
  });
});
