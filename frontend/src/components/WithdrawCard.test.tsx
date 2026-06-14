import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WithdrawCard } from "./WithdrawCard";
import { useWallet } from "../ton/useWallet";
import type { Wallet } from "../ton/useWallet";

const POOL = "0:" + "aa".repeat(32);

vi.mock("../ton/useWallet");
vi.mock("../config", () => ({ config: { addresses: { poolCore: "0:" + "aa".repeat(32) } } }));

function mockWallet(over: Partial<Wallet>) {
  vi.mocked(useWallet).mockReturnValue({
    address: "EQuser",
    rawAddress: "0:" + "bb".repeat(32),
    connected: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    ...over,
  });
}

test("withdraw sends RequestWithdraw to pool-core", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  mockWallet({ send });
  render(<WithdrawCard />);
  fireEvent.change(screen.getByPlaceholderText("0.0"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));

  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const [messages] = send.mock.calls[0] as [{ address: string; payload?: string }[]];
  expect(messages[0].address).toBe(POOL);
  expect(messages[0].payload).toBeTruthy();
});
