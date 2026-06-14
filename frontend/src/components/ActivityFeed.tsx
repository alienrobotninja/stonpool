import type { ActivityEvent } from "../api/types";
import { formatAmount, shortAddress } from "../format";
import { useEvents } from "../hooks/resources";

const LABEL: Record<ActivityEvent["kind"], string> = {
  deposit: "Deposit",
  withdrawal: "Withdraw",
  harvest: "Harvest",
  payout: "Payout",
};

function amountOf(e: ActivityEvent): number | null {
  return e.kind === "harvest" ? e.net_yield : e.amount;
}

export function ActivityFeed() {
  const { data, error } = useEvents();

  if (error) return <p className="text-sm text-rose-400">Could not load activity.</p>;
  if (!data) return <p className="text-sm text-neutral-500">Loading activity\u2026</p>;
  if (data.length === 0) return <p className="text-sm text-neutral-500">No activity yet.</p>;

  return (
    <ul className="divide-y divide-neutral-800 overflow-hidden rounded-xl border border-neutral-800">
      {data.map((e) => {
        const amt = amountOf(e);
        return (
          <li
            key={`${e.kind}-${e.tx_hash}-${e.address ?? ""}`}
            className="flex items-center justify-between px-4 py-2 text-sm"
          >
            <span className="flex items-center gap-2">
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
                {LABEL[e.kind]}
              </span>
              {e.address && (
                <span className="font-mono text-xs text-neutral-400">{shortAddress(e.address)}</span>
              )}
            </span>
            {amt !== null && <span className="tabular-nums">{formatAmount(amt)} jUSDT</span>}
          </li>
        );
      })}
    </ul>
  );
}
