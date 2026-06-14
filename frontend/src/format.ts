// jetton amounts are integer base units; jUSDT/jUSDC use 6 decimals.
export function formatAmount(raw: number, decimals = 6, maxFractionDigits = 2): string {
  return (raw / 10 ** decimals).toLocaleString("en-US", {
    maximumFractionDigits: maxFractionDigits,
  });
}