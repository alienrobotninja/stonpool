import { useWallet } from "../ton/useWallet";

function truncate(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}\u2026${addr.slice(-4)}` : addr;
}

export function WalletButton() {
  const { address, connected, connect, disconnect } = useWallet();

  if (connected) {
    return (
      <button
        onClick={() => void disconnect()}
        className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-medium text-neutral-200 transition hover:bg-neutral-800"
      >
        {truncate(address)}
      </button>
    );
  }
  return (
    <button
      onClick={() => connect()}
      className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-sky-400"
    >
      Connect wallet
    </button>
  );
}
