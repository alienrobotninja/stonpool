import { formatAmount } from "../format";

interface Props {
  balance: number | null;
  loading: boolean;
  onRefresh: () => void;
}

export function BalanceCard({ balance, loading, onRefresh }: Props) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-200">Your balance</h2>
        <button
          onClick={onRefresh}
          className="text-xs text-neutral-400 transition hover:text-neutral-200"
        >
          {loading ? "\u2026" : "Refresh"}
        </button>
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums">
        {balance === null ? "\u2014" : formatAmount(balance)}{" "}
        <span className="text-sm font-normal text-neutral-500">jUSDT</span>
      </p>
    </div>
  );
}
