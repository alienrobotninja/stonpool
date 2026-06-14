import { useState } from "react";

import { parseAmount } from "../format";

type Status = "idle" | "pending" | "sent" | "error";

interface Props {
  title: string;
  description: string;
  actionLabel: string;
  connected: boolean;
  onSubmit: (amount: bigint) => Promise<void>;
  onDone?: () => void;
}

export function AmountActionCard({
  title,
  description,
  actionLabel,
  connected,
  onSubmit,
  onDone,
}: Props) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setErr(null);
    let amount: bigint;
    try {
      amount = parseAmount(value);
    } catch {
      setErr("Enter a valid amount");
      return;
    }
    if (amount <= 0n) {
      setErr("Amount must be greater than zero");
      return;
    }
    setStatus("pending");
    try {
      await onSubmit(amount);
      setStatus("sent");
      setValue("");
      onDone?.();
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
      <h2 className="text-sm font-semibold text-neutral-200">{title}</h2>
      <p className="mt-1 text-sm text-neutral-400">{description}</p>
      <div className="mt-4 flex gap-2">
        <input
          inputMode="decimal"
          placeholder="0.0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={!connected || status === "pending"}
          className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm tabular-nums outline-none focus:border-sky-500 disabled:opacity-50"
        />
        <button
          onClick={() => void run()}
          disabled={!connected || status === "pending" || value.trim() === ""}
          className="shrink-0 rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "pending" ? "Confirm\u2026" : actionLabel}
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-rose-400">{err}</p>}
      {!connected && <p className="mt-2 text-xs text-neutral-500">Connect a wallet first.</p>}
      {status === "sent" && <p className="mt-2 text-xs text-emerald-400">Sent. Updating shortly.</p>}
      {status === "error" && (
        <p className="mt-2 text-xs text-rose-400">Transaction failed or rejected.</p>
      )}
    </div>
  );
}
