import { beginCell, Cell } from '@ton/core';

// pool-core role slots (OP_CONFIGURE_CORE payload: role:uint8, addr)
export const ROLE = {
  JETTON_WALLET: 0,
  ADAPTER: 1,
  DRAW_ENGINE: 2,
  VAULT: 3,
  GOVERNOR: 4,
} as const;

// stonfi adapter role slots (OP_CFG_STONFI_ADAPTER payload: role:uint8, addr)
export const SROLE = {
  POOL_CORE: 0,
  OWN_WALLET: 1,
  ROUTER: 2,
  LP_WALLET: 3,
  STONFI_POOL: 4,
} as const;

export const OP = {
  TRANSFER: 0x0f8a7ea5, // TEP-74 jetton transfer (AskToTransfer)
  FAUCET_REQUEST: 0x10000052,
  DEPOSIT: 0x10000001,
  REQUEST_WITHDRAW: 0x10000002,
  ADVANCE_EPOCH: 0x10000004,
  COMMIT: 0x10000011,
  REVEAL: 0x10000012,
  SETTLE_DRAW: 0x10000016,
  HARVEST_STONFI: 0x10000035,
  CONFIGURE_VAULT: 0x10000072,
  CONFIGURE_CORE: 0x10000073,
  CFG_STONFI_ADAPTER: 0x10000074,
  CFG_ROUTER: 0x7e571001,
  CFG_POOL: 0x7e571002,
  ACCRUE: 0x7e571004,
  SIMULATE_LOSS: 0x7e571005,
} as const;

export type PoolConfig = {
  epochLength: number;
  depositCutoff: number;
  commitWindow: number;
  revealWindow: number;
  minHoldEpochs: number;
  prizeTiers: number;
  skimBps: number;
  drawBond: bigint;
};

// pool-core folds config + wiring into one cell so its root stays under TON's 4-ref
// limit. Takes an already-packed config so it composes with either packConfig above or
// a spec's local copy. Governor storage keeps the bare config ref - different layout.
export function poolSetup(config: Cell, wiring: Cell | null = null): Cell {
  return beginCell().storeRef(config).storeMaybeRef(wiring).endCell();
}

// shared by pool-core and the governor; the on-chain layout must stay byte-identical
export function packConfig(c: PoolConfig): Cell {
  return beginCell()
    .storeUint(c.epochLength, 32)
    .storeUint(c.depositCutoff, 32)
    .storeUint(c.commitWindow, 32)
    .storeUint(c.revealWindow, 32)
    .storeUint(c.minHoldEpochs, 16)
    .storeUint(c.prizeTiers, 8)
    .storeUint(c.skimBps, 16)
    .storeCoins(c.drawBond)
    .endCell();
}