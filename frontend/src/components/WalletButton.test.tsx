import { useTonAddress } from "@tonconnect/ui-react";
import { render, screen } from "@testing-library/react";

import { WalletButton } from "./WalletButton";

test("renders connect when disconnected", () => {
  vi.mocked(useTonAddress).mockReturnValue("");
  render(<WalletButton />);
  expect(screen.getByRole("button")).toHaveTextContent(/connect wallet/i);
});

test("renders a truncated address when connected", () => {
  vi.mocked(useTonAddress).mockReturnValue("EQAbc123def456ghi789");
  render(<WalletButton />);
  expect(screen.getByRole("button")).toHaveTextContent("EQAb\u2026i789");
});
