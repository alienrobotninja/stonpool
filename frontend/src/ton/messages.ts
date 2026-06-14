import { beginCell } from "@ton/core";

export const OP_FAUCET_REQUEST = 0x10000052;

// RequestTokens{queryId:uint64}; the faucet drips jUSDT + jUSDC to the sender.
export function buildFaucetClaim(queryId = 0): string {
  return beginCell()
    .storeUint(OP_FAUCET_REQUEST, 32)
    .storeUint(queryId, 64)
    .endCell()
    .toBoc()
    .toString("base64");
}