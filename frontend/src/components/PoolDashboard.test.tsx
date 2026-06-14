import { render, screen } from "@testing-library/react";

import { PoolDashboard } from "./PoolDashboard";
import { usePool } from "../hooks/resources";
import { useNow } from "../hooks/useNow";
import type { Snapshot } from "../api/types";
import type { Poll } from "../hooks/usePoll";

vi.mock("../hooks/resources");
vi.mock("../hooks/useNow");

function poll(over: Partial<Poll<Snapshot | null>>): Poll<Snapshot | null> {
  return { data: null, loading: false, error: false, refresh: vi.fn(), ...over };
}

const SNAP: Snapshot = {
  epoch: 6,
  deposit_deadline: 1000 + 90000,
  total_principal: 10_000_000,
  prize_pot: 2_500_000,
  adapter_principal: 10_000_000,
  adapter_lp_balance: 10_000_000,
  stonfi_reserve: 12_500_000,
  stonfi_lp_supply: 10_000_000,
  accrued_yield: 2_500_000,
  created_at: "2026-01-01T00:00:00Z",
};

test("renders pool stats and countdown", () => {
  vi.mocked(useNow).mockReturnValue(1000);
  vi.mocked(usePool).mockReturnValue(poll({ data: SNAP }));
  render(<PoolDashboard />);
  expect(screen.getByText("10 jUSDT")).toBeInTheDocument();
  expect(screen.getByText("Epoch 6")).toBeInTheDocument();
  expect(screen.getByText("1d 1h")).toBeInTheDocument();
});

test("shows an error message", () => {
  vi.mocked(useNow).mockReturnValue(1000);
  vi.mocked(usePool).mockReturnValue(poll({ error: true }));
  render(<PoolDashboard />);
  expect(screen.getByText(/could not load/i)).toBeInTheDocument();
});
