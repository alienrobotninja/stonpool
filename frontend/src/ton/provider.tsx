import { TonConnectUIProvider } from "@tonconnect/ui-react";
import type { ReactNode } from "react";

// the manifest is served from the app itself; its `url` field must match this origin at
// deploy time (update public/tonconnect-manifest.json before building).
const manifestUrl =
  typeof window !== "undefined"
    ? `${window.location.origin}/tonconnect-manifest.json`
    : "/tonconnect-manifest.json";

export function TonProvider({ children }: { children: ReactNode }) {
  return <TonConnectUIProvider manifestUrl={manifestUrl}>{children}</TonConnectUIProvider>;
}
