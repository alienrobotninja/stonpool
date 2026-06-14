import { useState } from "react";

import { config } from "../config";
import { buildFaucetClaim } from "../ton/messages";
import { useWallet } from "../ton/useWallet";

const CLAIM_VALUE = "300000000"; // 0.3 TON covers the faucet's two mint sends

type Status = "idle" | "pending" | "sent" | "error";

export function FaucetCard({ onClaimed }: { onClaimed?: () => void }) {
  const { connected, send } = useWallet();
  const [status, setStatus] = useState<Status>("idle");

  async function claim() {
    setStatus("pending");
    try {
      await send([
        { address: config.addresses.faucet, amount: CLAIM_VALUE, payload: buildFaucetClaim() },
      ]);
      setStatus("sent");
      onClaimed?.();
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
      <h2 className="text-sm font-semibold text-neutral-200">Test faucet</h2>
      <p className="mt-1 text-sm text-neutral-400">
        Drip test jUSDT and jUSDC to your wallet to try the pool.
      </p>
      <button
        onClick={() => void claim()}
        disabled={!connected || status === "pending"}
        className="mt-4 rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "pending" ? "Confirm in wallet\u2026" : "Claim test tokens"}
      </button>
      {!connected && <p className="mt-2 text-xs text-neutral-500">Connect a wallet first.</p>}
      {status === "sent" && (
        <p className="mt-2 text-xs text-emerald-400">Claim sent. Balance updates shortly.</p>
      )}
      {status === "error" && (
        <p className="mt-2 text-xs text-rose-400">Claim failed or was rejected.</p>
      )}
    </div>
  );
}
