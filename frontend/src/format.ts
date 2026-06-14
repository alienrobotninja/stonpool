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