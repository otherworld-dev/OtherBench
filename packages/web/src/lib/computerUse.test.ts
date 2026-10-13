import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, computer: { status: vi.fn() } } };
});

import { api, ApiError } from '../state/api.js';
import { useComputerUseAvailable } from './computerUse.js';

const mockedStatus = vi.mocked(api.computer.status);

describe('useComputerUseAvailable', () => {
  afterEach(() => mockedStatus.mockReset());

  it('is true only once the server says computerUse: true', async () => {
    mockedStatus.mockResolvedValue({ computerUse: true });
    const { result } = renderHook(() => useComputerUseAvailable());
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
    expect(mockedStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['false', () => mockedStatus.mockResolvedValue({ computerUse: false })],
    ['a value that is not exactly true', () => mockedStatus.mockResolvedValue({ computerUse: 'yes' } as unknown as { computerUse: boolean })],
    ['a 401', () => mockedStatus.mockRejectedValue(new ApiError(401, 'Unauthorized'))],
    ['a 404 (an older server)', () => mockedStatus.mockRejectedValue(new ApiError(404, 'Not Found'))],
    ['a network error', () => mockedStatus.mockRejectedValue(new TypeError('Failed to fetch'))],
  ])('stays false for %s', async (_label, arrange) => {
    arrange();
    const { result } = renderHook(() => useComputerUseAvailable());
    await waitFor(() => expect(mockedStatus).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBe(false);
  });
});
