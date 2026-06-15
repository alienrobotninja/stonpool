// Build-time helpers (consumed by vite.config.ts, never bundled into the app).

export const REQUIRED_ENV = [
  "VITE_API_BASE_URL",
  "VITE_POOL_CORE_ADDRESS",
  "VITE_FAUCET_ADDRESS",
] as const;

// keys whose absence would ship a dead dApp (API pointed at localhost, dead deposit/withdraw/faucet)
export function missingEnv(
  env: Record<string, string | undefined>,
  required: readonly string[] = REQUIRED_ENV,
): string[] {
  return required.filter((k) => (env[k] ?? "").trim() === "");
}

export type TonConnectManifest = { url: string; name: string; iconUrl: string };

export function buildManifest(appUrl: string): TonConnectManifest {
  const url = appUrl.replace(/\/+$/, "");
  return { url, name: "STONPOOL", iconUrl: `${url}/icon-180.png` };
}