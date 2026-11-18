import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetOneProjectOpenForTests } from '../../state/oneProjectOpen.js';
import { resetTextSizeForTests } from '../../state/textSize.js';
import { AppearancePanel } from './AppearancePanel.js';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.style.fontSize = '';
  resetTextSizeForTests();
  resetOneProjectOpenForTests();
});
afterEach(cleanup);

describe('AppearancePanel', () => {
  it('lists the five steps and defaults to 100%', () => {
    render(<AppearancePanel />);
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Text size' });
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['85%', '100%', '115%', '130%', '150%']);
    expect(select.value).toBe('100');
  });

  it('applies and persists the chosen size', async () => {
    render(<AppearancePanel />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Text size' }), '130');
    expect(document.documentElement.style.fontSize).toBe('130%');
    expect(window.localStorage.getItem('otherbench.textSize')).toBe('130');
  });

  it('has One project open at a time on by default, and remembers switching it off', async () => {
    render(<AppearancePanel />);
    const box = screen.getByRole('checkbox', { name: 'One project open at a time' });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(box).not.toBeChecked();
    expect(window.localStorage.getItem('otherbench.oneProjectOpen')).toBe('false');
  });
});
