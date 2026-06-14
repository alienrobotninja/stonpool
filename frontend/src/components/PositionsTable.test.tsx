import { render, screen } from "@testing-library/react";

import { PositionsTable } from "./PositionsTable";
import { usePositions } from "../hooks/resources";
import { useWallet } from "../ton/useWallet";
import type { Position } from "../api/types";
import type { Wallet } from "../ton/useWallet";
import type { Poll } from "../hooks/usePoll";

const A = "0:" + "aa".repeat(32);
const B = "0:" + "bb".repeat(32);
const C = "0:" + "cc".repeat(32);

vi.mock("../hooks/resources");
vi.mock("../ton/useWallet");

function poll(over: Partial<Poll<Position[]>>): Poll<Position[]> {
  return { data: null, loading: false, error: false, refresh: vi.fn(), ...over };
}

function wallet(raw: string): Wallet {
  return {
    address: "",
    rawAddress: raw,
    connected: Boolean(raw),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
  };
}

const POSITIONS: Position[] = [
  { address: B, principal: 6_000_000, join_epoch: 5, eligible: true, odds: 0.6 },
  { address: A, principal: 4_000_000, join_epoch: 5, eligible: true, odds: 0.4 },
  { address: C, principal: 900_000, join_epoch: 6, eligible: false, odds: 0 },
];

test("renders ranked positions with odds and highlights your row", () => {
  vi.mocked(usePositions).mockReturnValue(poll({ data: POSITIONS }));
  vi.mocked(useWallet).mockReturnValue(wallet(A));
  render(<PositionsTable />);

  expect(screen.getByText("60.0%")).toBeInTheDocument();
  expect(screen.getByText("40.0%")).toBeInTheDocument();
  expect(screen.getByText("\u2014")).toBeInTheDocument(); // ineligible odds
  expect(screen.getByText("You")).toBeInTheDocument();
});

test("shows an empty state when there are no deposits", () => {
  vi.mocked(usePositions).mockReturnValue(poll({ data: [] }));
  vi.mocked(useWallet).mockReturnValue(wallet(""));
  render(<PositionsTable />);
  expect(screen.getByText(/no deposits yet/i)).toBeInTheDocument();
});

test("shows an error state", () => {
  vi.mocked(usePositions).mockReturnValue(poll({ error: true }));
  vi.mocked(useWallet).mockReturnValue(wallet(""));
  render(<PositionsTable />);
  expect(screen.getByText(/could not load positions/i)).toBeInTheDocument();
});
