import { render, screen } from "@testing-library/react";

import { DrawHistory } from "./DrawHistory";
import { useDraws } from "../hooks/resources";
import type { Draw } from "../api/types";
import type { Poll } from "../hooks/usePoll";

vi.mock("../hooks/resources");

function poll(over: Partial<Poll<Draw[]>>): Poll<Draw[]> {
  return { data: null, loading: false, error: false, refresh: vi.fn(), ...over };
}

const DRAWS: Draw[] = [
  { epoch: 5, seed: "0xabc", distributable: 2_250_000, skim: 250_000, num_winners: 2, settled_ts: 100, payouts: [] },
];

test("renders draws with awarded amount and winner count", () => {
  vi.mocked(useDraws).mockReturnValue(poll({ data: DRAWS }));
  render(<DrawHistory />);
  expect(screen.getByText("Epoch 5")).toBeInTheDocument();
  expect(screen.getByText("2.25 jUSDT")).toBeInTheDocument();
  expect(screen.getByText("2 winners")).toBeInTheDocument();
});

test("empty and error states", () => {
  vi.mocked(useDraws).mockReturnValue(poll({ data: [] }));
  const { rerender } = render(<DrawHistory />);
  expect(screen.getByText(/no draws yet/i)).toBeInTheDocument();
  vi.mocked(useDraws).mockReturnValue(poll({ error: true }));
  rerender(<DrawHistory />);
  expect(screen.getByText(/could not load draws/i)).toBeInTheDocument();
});
