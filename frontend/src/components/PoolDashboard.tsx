import { formatAmount, formatCountdown } from "../format";
import { useNow } from "../hooks/useNow";
import { usePool } from "../hooks/resources";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

export function PoolDashboard() {
  const { data, error } = usePool();
  const now = useNow();

  if (error) return <p className="text-sm text-rose-400">Could not load pool state.</p>;
  if (!data) return <p className="text-sm text-neutral-500">Loading pool\u2026</p>;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Total deposited" value={`${formatAmount(data.total_principal)} jUSDT`} />
      <Stat
        label="Prize pot"
        value={`${formatAmount(data.prize_pot)} jUSDT`}
        sub="awarded this epoch"
      />
      <Stat
        label="Accrued yield"
        value={`${formatAmount(data.accrued_yield)} jUSDT`}
        sub="growing now"
      />
      <Stat
        label={`Epoch ${data.epoch}`}
        value={formatCountdown(data.deposit_deadline, now)}
        sub="until deposits close"
      />
    </div>
  );
}
