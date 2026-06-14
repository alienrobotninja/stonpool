import { render, screen } from "@testing-library/react";

import { BalanceCard } from "./BalanceCard";

test("shows a dash when balance is unknown", () => {
  render(<BalanceCard balance={null} loading={false} onRefresh={() => {}} />);
  expect(screen.getByText("\u2014")).toBeInTheDocument();
});

test("formats a known balance", () => {
  render(<BalanceCard balance={5_000_000} loading={false} onRefresh={() => {}} />);
  expect(screen.getByText("5")).toBeInTheDocument();
});
