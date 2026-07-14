import { useState } from "react";

import { ActivityFeed } from "./components/ActivityFeed";
import { BalanceCard } from "./components/BalanceCard";
import { DepositCard } from "./components/DepositCard";
import { DrawHistory } from "./components/DrawHistory";
import { FaucetCard } from "./components/FaucetCard";
import { PoolDashboard } from "./components/PoolDashboard";
import { PositionsTable } from "./components/PositionsTable";
import { WalletButton } from "./components/WalletButton";
import { WithdrawCard } from "./components/WithdrawCard";
import { useJettonBalance } from "./hooks/useJettonBalance";
import { useWallet } from "./ton/useWallet";

export function Dapp() {
  const { rawAddress } = useWallet();
  const { balance, loading, refresh } = useJettonBalance(rawAddress);
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => {
    void refresh();
    setRefreshKey((k) => k + 1);
  };

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

      <main className="mx-auto max-w-5xl space-y-10 px-6 py-16">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">No-loss prize pool</h1>
          <p className="mt-3 max-w-xl text-neutral-400">
            Keep your principal. The pooled yield earns on STON.fi and funds a verifiable
            on-chain draw every epoch.
          </p>
        </div>

        <PoolDashboard key={`pool-${refreshKey}`} />

        <div className="grid gap-4 sm:grid-cols-2">
          <BalanceCard balance={balance} loading={loading} onRefresh={bump} />
          <FaucetCard onClaimed={bump} />
          <DepositCard onDone={bump} />
          <WithdrawCard onDone={bump} />
        </div>

        <PositionsTable key={`pos-${refreshKey}`} />
        <DrawHistory key={`draws-${refreshKey}`} />
        <ActivityFeed key={`feed-${refreshKey}`} />
      </main>
    </div>
  );
}

