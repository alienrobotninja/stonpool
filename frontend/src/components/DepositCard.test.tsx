import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DepositCard } from "./DepositCard";
import { api } from "../api/client";
import { useWallet } from "../ton/useWallet";
import type { Wallet } from "../ton/useWallet";

const USER = "0:" + "bb".repeat(32);
const JW = "0:" + "cc".repeat(32);

vi.mock("../ton/useWallet");
vi.mock("../api/client", () => ({ api: { getWalletBalance: vi.fn() } }));
vi.mock("../config", () => ({
  config: { addresses: { poolCore: "0:" + "aa".repeat(32) } },
}));

function mockWallet(over: Partial<Wallet>) {
  vi.mocked(useWallet).mockReturnValue({
    address: "EQuser",
    rawAddress: USER,
    connected: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    ...over,
  });
}

test("deposit resolves the jetton wallet and sends a transfer there", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  mockWallet({ send });
  vi.mocked(api.getWalletBalance).mockResolvedValue({
    owner: USER,
    jetton_wallet: JW,
    balance: 0,
  });
  render(<DepositCard />);
  fireEvent.change(screen.getByPlaceholderText("0.0"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "Deposit" }));

  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const [messages] = send.mock.calls[0] as [{ address: string; payload?: string }[]];
  expect(messages[0].address).toBe(JW);
  expect(messages[0].payload).toBeTruthy();
});
