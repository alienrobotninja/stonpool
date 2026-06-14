import { act, renderHook } from "@testing-library/react";

import { useNow } from "./useNow";

test("advances with the clock", () => {
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() => useNow(1000));
    const start = result.current;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBeGreaterThanOrEqual(start + 3);
  } finally {
    vi.useRealTimers();
  }
});