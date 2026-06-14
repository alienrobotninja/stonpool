import { render, screen } from "@testing-library/react";

import { ActivityFeed } from "./ActivityFeed";
import { useEvents } from "../hooks/resources";
import type { ActivityEvent } from "../api/types";
import type { Poll } from "../hooks/usePoll";

vi.mock("../hooks/resources");

function poll(over: Partial<Poll<ActivityEvent[]>>): Poll<ActivityEvent[]> {
  return { data: null, loading: false, error: false, refresh: vi.fn(), ...over };
}

const EVENTS: ActivityEvent[] = [
  {
    kind: "deposit",
    tx_hash: "h1",
    lt: 10,
    ts: 1,
    epoch: 5,
    address: "0:" + "ab".repeat(32),
    amount: 4_000_000,
    gross_yield: null,
    net_yield: null,
    lp_burned: null,
    tier: null,
  },
  {
    kind: "harvest",
    tx_hash: "h2",
    lt: 20,
    ts: 2,
    epoch: 5,
    address: null,
    amount: null,
    gross_yield: 2_500_000,
    net_yield: 2_475_000,
    lp_burned: 2_000_000,
    tier: null,
  },
];

test("renders events with labels and amounts", () => {
  vi.mocked(useEvents).mockReturnValue(poll({ data: EVENTS }));
  render(<ActivityFeed />);
  expect(screen.getByText("Deposit")).toBeInTheDocument();
  expect(screen.getByText("4 jUSDT")).toBeInTheDocument();
  expect(screen.getByText("Harvest")).toBeInTheDocument();
  expect(screen.getByText("2.48 jUSDT")).toBeInTheDocument(); // net_yield, rounded
});

test("empty state", () => {
  vi.mocked(useEvents).mockReturnValue(poll({ data: [] }));
  render(<ActivityFeed />);
  expect(screen.getByText(/no activity yet/i)).toBeInTheDocument();
});
