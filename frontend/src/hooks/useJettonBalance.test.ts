import { act, renderHook, waitFor } from "@testing-library/react";

import { api } from "../api/client";
import { useJettonBalance } from "./useJettonBalance";

vi.mock("../api/client", () => ({ api: { getWalletBalance: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

test("fetches the balance for a connected address", async () => {
  vi.mocked(api.getWalletBalance).mockResolvedValue({
    owner: "0:1",
    jetton_wallet: "0:2",
    balance: 7,
  });
  const { result } = renderHook(() => useJettonBalance("0:1", 100000));
  await waitFor(() => expect(result.current.balance).toBe(7));
});

test("does not fetch when disconnected", async () => {
  const { result } = renderHook(() => useJettonBalance("", 100000));
  await waitFor(() => expect(result.current.balance).toBeNull());
  expect(api.getWalletBalance).not.toHaveBeenCalled();
});

test("refresh re-fetches the balance", async () => {
  vi.mocked(api.getWalletBalance).mockResolvedValue({
    owner: "0:1",
    jetton_wallet: "0:2",
    balance: 3,
  });
  const { result } = renderHook(() => useJettonBalance("0:1", 100000));
  await waitFor(() => expect(result.current.balance).toBe(3));

  vi.mocked(api.getWalletBalance).mockResolvedValue({
    owner: "0:1",
    jetton_wallet: "0:2",
    balance: 9,
  });
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.balance).toBe(9);
})