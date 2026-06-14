import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { FaucetCard } from "./FaucetCard";
import { useWallet } from "../ton/useWallet";
import type { Wallet } from "../ton/useWallet";

vi.mock("../ton/useWallet");

function mockWallet(over: Partial<Wallet>) {
  vi.mocked(useWallet).mockReturnValue({
    address: "",
    rawAddress: "",
    connected: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    ...over,
  });
}

test("claim is disabled until a wallet connects", () => {
  mockWallet({ connected: false });
  render(<FaucetCard />);
  expect(screen.getByRole("button")).toBeDisabled();
});

test("clicking claim sends a faucet message and notifies onClaimed", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const onClaimed = vi.fn();
  mockWallet({ connected: true, send });
  render(<FaucetCard onClaimed={onClaimed} />);

  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

  const [messages] = send.mock.calls[0] as [{ payload?: string }[]];
  expect(messages[0].payload).toBeTruthy();
  await screen.findByText(/claim sent/i);
  expect(onClaimed).toHaveBeenCalledTimes(1);
});
