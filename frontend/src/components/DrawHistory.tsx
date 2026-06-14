import { formatAmount, shortAddress } from "../format";
import { useDraws } from "../hooks/resources";

export function DrawHistory() {
  const { data, error } = useDraws();

  if (error) return <p className="text-sm text-rose-400">Could not load draws.</p>;
  if (!data) return <p className="text-sm text-neutral-500">Loading draws\u2026</p>;
  if (data.length === 0) return <p className="text-sm text-neutral-500">No draws yet.</p>;

  return (
    <div className="space-y-3">
      {data.map((d) => (
        <div key={d.epoch} className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Epoch {d.epoch}</span>
            <span className="text-sm tabular-nums text-emerald-400">
              {formatAmount(d.distributable)} jUSDT
            </span>
          </div>
          {d.payouts.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs text-neutral-400">
              {d.payouts.map((p) => (
                <li key={`${p.tx_hash}-${p.winner}`} className="flex justify-between">
                  <span className="font-mono">{shortAddress(p.winner)}</span>
                  <span className="tabular-nums">{formatAmount(p.amount)} jUSDT</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-neutral-500">
              {d.num_winners} winner{d.num_winners === 1 ? "" : "s"}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
