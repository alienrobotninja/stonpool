import { act, renderHook, waitFor } from "@testing-library/react";

import { usePoll } from "./usePoll";

test("fetches on mount", async () => {
  const fetcher = vi.fn().mockResolvedValue(42);
  const { result } = renderHook(() => usePoll(fetcher, 100000));
  await waitFor(() => expect(result.current.data).toBe(42));
  expect(result.current.error).toBe(false);
});

test("sets error when the fetcher rejects", async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
  const { result } = renderHook(() => usePoll(fetcher, 100000));
  await waitFor(() => expect(result.current.error).toBe(true));
  expect(result.current.data).toBeNull();
});

test("does nothing when disabled", async () => {
  const fetcher = vi.fn().mockResolvedValue(1);
  const { result } = renderHook(() => usePoll(fetcher, 100000, false));
  await waitFor(() => expect(result.current.data).toBeNull());
  expect(fetcher).not.toHaveBeenCalled();
});

test("refresh re-fetches", async () => {
  const fetcher = vi.fn().mockResolvedValue("a");
  const { result } = renderHook(() => usePoll(fetcher, 100000));
  await waitFor(() => expect(result.current.data).toBe("a"));
  fetcher.mockResolvedValue("b");
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.data).toBe("b");
});