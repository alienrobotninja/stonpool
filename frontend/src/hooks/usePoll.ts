import { useCallback, useEffect, useRef, useState } from "react";

export interface Poll<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
}

// generic polling hook. the fetcher is kept in a ref so an inline arrow (a new function
// each render) does not re-subscribe the interval; only enabled/interval changes do.
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs = 12000, enabled = true): Poll<T> {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      setData(await fetcherRef.current());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const id = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs, enabled]);

  return { data, loading, error, refresh };
}