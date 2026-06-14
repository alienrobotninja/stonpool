import { render, screen } from "@testing-library/react";

import App from "./App";

test("renders the headline", () => {
  render(<App />);
  expect(screen.getByText(/no-loss prize pool/i)).toBeInTheDocument();
});
