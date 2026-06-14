import { BalanceCard } from "./components/BalanceCard";
import { FaucetCard } from "./components/FaucetCard";
import { WalletButton } from "./components/WalletButton";
import { useJettonBalance } from "./hooks/useJettonBalance";
import { useWallet } from "./ton/useWallet";

export function Dapp() {
  const { rawAddress } = useWallet();
  const { balance, loading, refresh } = useJettonBalance(rawAddress);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold tracking-tight">STONPOOL</span>
            <span className="rounded-full border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400">
              testnet
            </span>
          </div>
          <WalletButton />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">No-loss prize pool</h1>
        <p className="mt-3 max-w-xl text-neutral-400">
          Keep your principal. The pooled yield earns on STON.fi and funds a verifiable
          on-chain draw every epoch.
        </p>

        <div className="mt-10 grid max-w-2xl gap-4 sm:grid-cols-2">
          <BalanceCard balance={balance} loading={loading} onRefresh={() => void refresh()} />
          <FaucetCard onClaimed={() => void refresh()} />
        </div>
      </main>
    </div>
  );
}
