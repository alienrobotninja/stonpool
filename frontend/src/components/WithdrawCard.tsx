import { config } from "../config";
import { buildWithdraw, WITHDRAW_MSG_VALUE } from "../ton/messages";
import { useWallet } from "../ton/useWallet";

import { AmountActionCard } from "./AmountActionCard";

export function WithdrawCard({ onDone }: { onDone?: () => void }) {
  const { connected, send } = useWallet();

  async function submit(amount: bigint) {
    await send([
      {
        address: config.addresses.poolCore,
        amount: WITHDRAW_MSG_VALUE,
        payload: buildWithdraw(amount),
      },
    ]);
  }

  return (
    <AmountActionCard
      title="Withdraw"
      description="Withdraw your principal at any time."
      actionLabel="Withdraw"
      connected={connected}
      onSubmit={submit}
      onDone={onDone}
    />
  );
}
