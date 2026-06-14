import { api } from "../api/client";
import { config } from "../config";
import { buildJettonDeposit, DEPOSIT_MSG_VALUE } from "../ton/messages";
import { useWallet } from "../ton/useWallet";

import { AmountActionCard } from "./AmountActionCard";

export function DepositCard({ onDone }: { onDone?: () => void }) {
  const { rawAddress, connected, send } = useWallet();

  async function submit(amount: bigint) {
    const { jetton_wallet } = await api.getWalletBalance(rawAddress);
    await send([
      {
        address: jetton_wallet,
        amount: DEPOSIT_MSG_VALUE,
        payload: buildJettonDeposit({ amount, poolCore: config.addresses.poolCore, user: rawAddress }),
      },
    ]);
  }

  return (
    <AmountActionCard
      title="Deposit"
      description="Deposit jUSDT into the pool. Your principal is always withdrawable."
      actionLabel="Deposit"
      connected={connected}
      onSubmit={submit}
      onDone={onDone}
    />
  );
}
