import { formatAmount, shortAddress } from "../format";
import { usePositions } from "../hooks/resources";
import { useWallet } from "../ton/useWallet";

export function PositionsTable() {
  const { data, error } = usePositions();
  const { rawAddress } = useWallet();

  if (error) return <p className="text-sm text-rose-400">Could not load positions.</p>;
  if (!data) return <p className="text-sm text-neutral-500">Loading positions\u2026</p>;
  if (data.length === 0) return <p className="text-sm text-neutral-500">No deposits yet.</p>;

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-800">
      <table className="w-full text-sm">
        <thead className="bg-neutral-900/60 text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-4 py-2 font-medium">#</th>
            <th className="px-4 py-2 font-medium">Depositor</th>
            <th className="px-4 py-2 text-right font-medium">Principal</th>
            <th className="px-4 py-2 text-right font-medium">Win odds</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800">
          {data.map((p, i) => {
            const mine = p.address === rawAddress;
            return (
              <tr key={p.address} className={mine ? "bg-sky-500/10" : undefined}>
                <td className="px-4 py-2 tabular-nums text-neutral-400">{i + 1}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  {shortAddress(p.address)}
                  {mine && (
                    <span className="ml-2 rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
                      You
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{formatAmount(p.principal)}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {p.eligible ? `${(p.odds * 100).toFixed(1)}%` : "\u2014"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
