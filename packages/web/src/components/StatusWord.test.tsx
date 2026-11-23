import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusWord } from './StatusWord.js';

afterEach(cleanup);

describe('StatusWord: done and what is left', () => {
  it('says Done', () => {
    render(<StatusWord status="done" testId="w" />);
    expect(screen.getByTestId('w').textContent).toBe('Done');
    expect(screen.getByTestId('w').getAttribute('title')).toBe('Finished: nothing left, check and archive');
  });

  it('counts untagged items from older replies as left, in amber, with the items on hover', () => {
    render(<StatusWord status="left" left={[{ text: 'push' }, { text: 'docs' }]} testId="w" />);
    expect(screen.getByTestId('w').textContent).toBe('2 left');
    expect(screen.getByTestId('w').getAttribute('title')).toBe('Left:\n  push\n  docs');
    expect(screen.getByTestId('w').className).toContain('text-[var(--warn)]');
  });

  it('says how many wait on the user, in amber, with every item grouped on hover', () => {
    render(<StatusWord status="left" left={[{ text: 'push', who: 'me' }, { text: 'try it', who: 'you' }, { text: 'docs', who: 'parked' }]} testId="w" />);
    const word = screen.getByTestId('w');
    expect(word.textContent).toBe('1 for you');
    expect(word.getAttribute('data-for-you')).toBe('1');
    expect(word.getAttribute('title')).toBe('Needs you now:\n  try it\nNext from me:\n  push\nParked:\n  docs');
    expect(word.className).toContain('text-[var(--warn)]');
  });

  it('is quiet when nothing left waits on the user', () => {
    render(<StatusWord status="left" left={[{ text: 'push', who: 'me' }, { text: 'docs', who: 'parked' }]} testId="w" />);
    const word = screen.getByTestId('w');
    expect(word.textContent).toBe('2 left');
    expect(word.getAttribute('data-for-you')).toBe('0');
    expect(word.className).toContain('text-[var(--text-muted)]');
    expect(word.className).not.toContain('text-[var(--warn)]');
  });

  it('counts only what the user can act on now', () => {
    render(<StatusWord status="left" left={[{ text: 'token', who: 'you' }, { text: 'retry?', who: 'you', when: 'optional' }, { text: 'first issue', who: 'you', when: 'later' }]} testId="w" />);
    expect(screen.getByTestId('w').textContent).toBe('1 for you');
  });

  it('stays amber for an optional question, and is quiet for what the user cannot do yet', () => {
    const { unmount } = render(<StatusWord status="left" left={[{ text: 'retry?', who: 'you', when: 'optional' }, { text: 'push', who: 'me' }]} testId="w" />);
    expect(screen.getByTestId('w').textContent).toBe('2 left');
    expect(screen.getByTestId('w').className).toContain('text-[var(--warn)]');
    unmount();
    render(<StatusWord status="left" left={[{ text: 'first issue', who: 'you', when: 'later' }, { text: 'push', who: 'me' }]} testId="w" />);
    expect(screen.getByTestId('w').className).toContain('text-[var(--text-muted)]');
  });

  it('says Work left when it is not told the items', () => {
    render(<StatusWord status="left" testId="w" />);
    expect(screen.getByTestId('w').textContent).toBe('Work left');
  });
});
