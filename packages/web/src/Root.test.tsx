import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./App.js', () => ({ App: () => <div data-testid="app" /> }));
vi.mock('./state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state/api.js')>();
  return { ...actual, api: { auth: { status: vi.fn(async () => ({ mode: 'open', signedIn: true })) } } };
});

import { api } from './state/api.js';
import { useAuthStore } from './state/auth.js';
import { Root } from './Root.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe('Root', () => {
  it('in the desktop app renders the app with no sign-in gate, never asking the status route', () => {
    render(<Root desktop />);

    expect(screen.getByTestId('app')).toBeInTheDocument();
    expect(api.auth.status).not.toHaveBeenCalled();
  });

  it('in a browser asks the status route before showing the app', async () => {
    render(<Root desktop={false} />);

    expect(await screen.findByTestId('app')).toBeInTheDocument();
    expect(api.auth.status).toHaveBeenCalledTimes(1);
  });
});
