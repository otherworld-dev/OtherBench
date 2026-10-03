import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTextSizeForTests } from '../../state/textSize.js';
import { AppearancePanel } from './AppearancePanel.js';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.style.fontSize = '';
  resetTextSizeForTests();
});
afterEach(cleanup);

describe('AppearancePanel', () => {
  it('lists the five steps and defaults to 100%', () => {
    render(<AppearancePanel />);
    const select = screen.getByRole('combobox', { name: 'Text size' }) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['85%', '100%', '115%', '130%', '150%']);
    expect(select.value).toBe('100');
  });

  it('applies and persists the chosen size', async () => {
    render(<AppearancePanel />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Text size' }), '130');
    expect(document.documentElement.style.fontSize).toBe('130%');
    expect(window.localStorage.getItem('grunt.textSize')).toBe('130');
  });
});
