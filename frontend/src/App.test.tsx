import { render, screen } from "@testing-library/react";

import App from "./App";
import type { Poll } from "./hooks/usePoll";

function poll<T>(): Poll<T> {
  return { data: null, loading: false, error: false, refresh: vi.fn() };
}

vi.mock("./hooks/resources", () => ({
  usePool: () => poll(),
  usePositions: () => poll(),
  useDraws: () => poll(),
  useEvents: () => poll(),
}));

vi.mock("./hooks/useJettonBalance", () => ({
  useJettonBalance: () => ({ balance: null, loading: false, refresh: vi.fn() }),
}));

test("renders the headline", () => {
  render(<App />);
  expect(screen.getByText(/no-loss prize pool/i)).toBeInTheDocument();
});
