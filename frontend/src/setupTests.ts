import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import { vi } from "vitest";

vi.mock("@tonconnect/ui-react", () => ({
  TonConnectUIProvider: ({ children }: { children: ReactNode }) => children,
  useTonAddress: vi.fn(() => ""),
  useTonConnectUI: vi.fn(() => [{ openModal: vi.fn(), disconnect: vi.fn() }]),
}));