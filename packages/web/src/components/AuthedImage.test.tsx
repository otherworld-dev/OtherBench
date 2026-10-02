import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { configureTransport } from '../state/transport.js';
import { AuthedImage } from './AuthedImage.js';

afterEach(() => {
  cleanup();
  configureTransport({ baseUrl: '', token: null });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AuthedImage', () => {
  it('in browser mode renders the URL directly, fetching nothing', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<AuthedImage src="/api/attachments/a1/content" alt="" data-testid="img" />);

    expect(screen.getByTestId('img').getAttribute('src')).toBe('/api/attachments/a1/content');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with a token, fetches with Authorization and shows an object URL, revoking it on unmount', async () => {
    configureTransport({ baseUrl: 'http://127.0.0.1:5000', token: 'tok' });
    const fetchSpy = vi.fn(async () => new Response(new Blob(['png-bytes'], { type: 'image/png' })));
    vi.stubGlobal('fetch', fetchSpy);
    const createObjectURL = vi.fn(() => 'blob:fake-1');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));

    const { unmount } = render(<AuthedImage src="http://127.0.0.1:5000/api/attachments/a1/content" alt="" data-testid="img" />);

    await waitFor(() => expect(screen.getByTestId('img').getAttribute('src')).toBe('blob:fake-1'));
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-1');
  });

  it('with a token, renders nothing for a failed fetch rather than a broken image', async () => {
    configureTransport({ baseUrl: '', token: 'tok' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })));

    render(<AuthedImage src="/api/attachments/a1/content" alt="" data-testid="img" />);

    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('img')).toBeNull();
  });
});
