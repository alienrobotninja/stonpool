import { Address, Cell, contractAddress, toNano } from '@ton/core';
import { walletData } from '../wrappers/mockStack';
import { PoolConfig } from '../wrappers/protocol';
import { poolCoreData } from '../wrappers/PoolCore';
import { yieldAdapterStonfiData } from '../wrappers/YieldAdapterStonfi';
import { jettonVaultData } from '../wrappers/JettonVault';
import { drawEngineData } from '../wrappers/DrawEngine';
import { paramGovernorData } from '../wrappers/ParamGovernor';
import { mockStonfiRouterData } from '../wrappers/MockStonfiRouter';
import { mockStonfiPoolData } from '../wrappers/MockStonfiPool';

export const DEFAULT_CONFIG: PoolConfig = {
  epochLength: 3600,
  depositCutoff: 600,
  commitWindow: 900,
  revealWindow: 900,
  minHoldEpochs: 1,
  prizeTiers: 3,
  skimBps: 1000,
  drawBond: toNano('1'),
};

// short windows so a full deposit -> draw -> payout cycle runs in minutes during a demo.
// yield is not a config knob on the stonfi path; runDemoCycle injects it via MockStonfiPool.accrue.
export const DEMO_CONFIG: PoolConfig = {
  epochLength: 600,
  depositCutoff: 120,
  commitWindow: 120,
  revealWindow: 120,
  minHoldEpochs: 1,
  prizeTiers: 3,
  skimBps: 1000,
  drawBond: toNano('0.2'),
};

// Stage 3 target: what the governor proposes over the deployed DEMO_CONFIG. Halves the
// cycle (epoch 600 -> 300) while keeping commit/reveal well above the keeper's reaction
// time. minHoldEpochs stays 1 - it is a product property, not a demo knob, and faking it
// would misrepresent the mechanic. prizeTiers stays 3: it is clamped at runtime to the
// eligible count, so it only reads as a real draw when the field is several times larger.
export const GOVERNED_CONFIG: PoolConfig = {
  epochLength: 300,
  depositCutoff: 60,
  commitWindow: 90,
  revealWindow: 90,
  minHoldEpochs: 1,
  prizeTiers: 3,
  skimBps: 1000,
  drawBond: toNano('0.2'),
};

export const DEFAULT_TIMELOCK = 3600;
export const DEMO_TIMELOCK = 60;

export type Codes = {
  poolCore: Cell;
  adapter: Cell;
  vault: Cell;
  drawEngine: Cell;
  governor: Cell;
  router: Cell;
  stonfiPool: Cell;
  wallet: Cell;
};

export type PlanInput = {
  admin: Address;
  minter: Address; // underlying stable the pool accepts (from deployMockStack)
  genesis: number;
  epoch: number;
  demo: boolean;
  codes: Codes;
};

export type Plan = {
  config: PoolConfig;
  timelock: number;
  core: {
    poolCore: Address;
    adapter: Address;
    vault: Address;
    drawEngine: Address;
    governor: Address;
    router: Address;
    stonfiPool: Address;
  };
  wallets: {
    poolWallet: Address;
    adapterWallet: Address;
    adapterLpWallet: Address;
    vaultWallet: Address;
    routerWallet: Address;
  };
};

export function buildPlan(input: PlanInput): Plan {
  const { admin, minter, genesis, epoch, demo, codes } = input;
  const config = demo ? DEMO_CONFIG : DEFAULT_CONFIG;
  const timelock = demo ? DEMO_TIMELOCK : DEFAULT_TIMELOCK;
  const at = (code: Cell, data: Cell) => contractAddress(0, { code, data });

  const poolCore = at(codes.poolCore, poolCoreData({ epoch, genesis, admin, config }));
  // seed poolCore into the adapter init so its address is deployment-scoped (fresh state per redeploy)
  const adapter = at(codes.adapter, yieldAdapterStonfiData(admin, poolCore));
  const vault = at(codes.vault, jettonVaultData(admin));
  const router = at(codes.router, mockStonfiRouterData(admin));
  const stonfiPool = at(codes.stonfiPool, mockStonfiPoolData(admin, codes.wallet));
  const drawEngine = at(codes.drawEngine, drawEngineData({
    poolCore, commitWindow: config.commitWindow, revealWindow: config.revealWindow, drawBond: config.drawBond,
  }));
  const governor = at(codes.governor, paramGovernorData({ admin, poolCore, timelockDelay: timelock, config }));

  // jetton wallets are deterministic from (owner, minter); the LP wallet is minted by the stonfi pool
  const walletOf = (owner: Address, m: Address) => at(codes.wallet, walletData(0n, owner, m));

  return {
    config,
    timelock,
    core: { poolCore, adapter, vault, drawEngine, governor, router, stonfiPool },
    wallets: {
      poolWallet: walletOf(poolCore, minter),
      adapterWallet: walletOf(adapter, minter),
      adapterLpWallet: walletOf(adapter, stonfiPool),
      vaultWallet: walletOf(vault, minter),
      routerWallet: walletOf(router, minter),
    },
  };
}

// raw form ("0:hex") is network-agnostic and parsed by both the python backend and the frontend
const raw = (a: Address) => a.toRawString();

export function envBlock(minter: Address, p: Plan): string {
  const c = p.core;
  return [
    '# --- backend/.env ---',
    `STONPOOL_JETTON_MASTER_ADDRESS=${raw(minter)}`,
    `STONPOOL_POOL_CORE_ADDRESS=${raw(c.poolCore)}`,
    `STONPOOL_ADAPTER_ADDRESS=${raw(c.adapter)}`,
    `STONPOOL_DRAW_ENGINE_ADDRESS=${raw(c.drawEngine)}`,
    `STONPOOL_VAULT_ADDRESS=${raw(c.vault)}`,
    `STONPOOL_GOVERNOR_ADDRESS=${raw(c.governor)}`,
    '',
    '# --- frontend/.env (VITE_FAUCET_ADDRESS comes from deployMockStack) ---',
    `VITE_POOL_CORE_ADDRESS=${raw(c.poolCore)}`,
    `VITE_JETTON_MINTER_ADDRESS=${raw(minter)}`,
    `VITE_ADAPTER_ADDRESS=${raw(c.adapter)}`,
  ].join('\n');
}