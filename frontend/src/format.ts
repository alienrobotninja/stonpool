// jetton amounts are integer base units; jUSDT/jUSDC use 6 decimals.
export function formatAmount(raw: number, decimals = 6, maxFractionDigits = 2): string {
  return (raw / 10 ** decimals).toLocaleString("en-US", {
    maximumFractionDigits: maxFractionDigits,
  });
}

export function formatCountdown(deadlineSec: number, nowSec: number): string {
  const s = deadlineSec - nowSec;
  if (s <= 0) return "Closed";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// parse a decimal token string ("10.5") into integer base units, via string math to avoid
// float precision loss. throws on malformed input.
export function parseAmount(input: string, decimals = 6): bigint {
  const t = input.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("invalid amount");
  const [whole, frac = ""] = t.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

export function shortAddress(addr: string, head = 6, tail = 4): string {
  return addr.length > head + tail + 1 ? `${addr.slice(0, head)}\u2026${addr.slice(-tail)}` : addr;
}