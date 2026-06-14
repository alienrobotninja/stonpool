import { useCallback, useEffect, useState } from "react";

import { api } from "../api/client";

export interface JettonBalance {
  balance: number | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useJettonBalance(address: string, intervalMs = 15000): JettonBalance {
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!address) {
      setBalance(null);
      return;
    }
    setLoading(true);
    try {
      const { balance: b } = await api.getWalletBalance(address);
      setBalance(b);
    } catch {
      setBalance(null);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void refresh();
    if (!address) return;
    const id = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(id);
  }, [refresh, address, intervalMs]);

  return { balance, loading, refresh };
}