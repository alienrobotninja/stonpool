import { Address, beginCell } from "@ton/core";

export const OP_FAUCET_REQUEST = 0x10000052;
export const OP_JETTON_TRANSFER = 0x0f8a7ea5;
export const OP_DEPOSIT = 0x10000001;
export const OP_REQUEST_WITHDRAW = 0x10000002;

// 0.1 TON funds the transfer notification that reaches pool-core; the wallet message
// itself carries DEPOSIT_MSG_VALUE to cover transfer gas plus this forward.
export const DEPOSIT_FORWARD_TON = 100_000_000n;
export const DEPOSIT_MSG_VALUE = "250000000"; // 0.25 TON
export const WITHDRAW_MSG_VALUE = "150000000"; // 0.15 TON

function addr(a: string): Address {
  return a.includes(":") ? Address.parseRaw(a) : Address.parse(a);
}

// RequestTokens{queryId}; the faucet drips jUSDT + jUSDC to the sender.
export function buildFaucetClaim(queryId = 0): string {
  return beginCell()
    .storeUint(OP_FAUCET_REQUEST, 32)
    .storeUint(queryId, 64)
    .endCell()
    .toBoc()
    .toString("base64");
}

// TEP-74 transfer sent to the user's own jetton wallet. The inline forwardPayload is
// OP_DEPOSIT + the depositor, which pool-core reads off the transfer notification.
export function buildJettonDeposit(opts: {
  amount: bigint;
  poolCore: string;
  user: string;
  forwardTon?: bigint;
  queryId?: number;
}): string {
  const { amount, poolCore, user, forwardTon = DEPOSIT_FORWARD_TON, queryId = 0 } = opts;
  return beginCell()
    .storeUint(OP_JETTON_TRANSFER, 32)
    .storeUint(queryId, 64)
    .storeCoins(amount)
    .storeAddress(addr(poolCore))
    .storeAddress(addr(user))
    .storeMaybeRef(null)
    .storeCoins(forwardTon)
    .storeUint(OP_DEPOSIT, 32)
    .storeAddress(addr(user))
    .endCell()
    .toBoc()
    .toString("base64");
}

// RequestWithdraw{queryId, amount} sent directly to pool-core.
export function buildWithdraw(amount: bigint, queryId = 0): string {
  return beginCell()
    .storeUint(OP_REQUEST_WITHDRAW, 32)
    .storeUint(queryId, 64)
    .storeCoins(amount)
    .endCell()
    .toBoc()
    .toString("base64");
}