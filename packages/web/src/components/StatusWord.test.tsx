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

  it('counts what is left, with the items on hover', () => {
    render(<StatusWord status="left" left={['push', 'docs']} testId="w" />);
    expect(screen.getByTestId('w').textContent).toBe('2 left');
    expect(screen.getByTestId('w').getAttribute('title')).toBe('push\ndocs');
  });

  it('says Work left when it is not told the items', () => {
    render(<StatusWord status="left" testId="w" />);
    expect(screen.getByTestId('w').textContent).toBe('Work left');
  });
});
