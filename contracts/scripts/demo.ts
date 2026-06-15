import { Address, beginCell, Cell, toNano } from '@ton/core';
import { OP } from '../wrappers/protocol';

const h256 = (c: Cell): bigint => BigInt('0x' + c.hash().toString('hex'));

// must match the keeper/contract: commit_hash(s) = sha256(uint256 s); seed mixing chains reveals
export const commitHashOf = (secret: bigint): bigint => h256(beginCell().storeUint(secret, 256).endCell());
export const mixSeed = (seed: bigint, secret: bigint): bigint =>
  h256(beginCell().storeUint(seed, 256).storeUint(secret, 256).endCell());

export function buildFaucetClaim(queryId = 0n): Cell {
  return beginCell().storeUint(OP.FAUCET_REQUEST, 32).storeUint(queryId, 64).endCell();
}

// TEP-74 transfer sent to the depositor's OWN jetton wallet, routing `amount` to the pool with the
// inline OP_DEPOSIT+depositor forward payload pool-core reads off the transfer notification.
export function buildDeposit(opts: {
  amount: bigint;
  pool: Address;
  user: Address;
  forwardTon?: bigint;
  queryId?: bigint;
}): Cell {
  const forwardTon = opts.forwardTon ?? toNano('0.6');
  return beginCell()
    .storeUint(OP.TRANSFER, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeCoins(opts.amount)
    .storeAddress(opts.pool)
    .storeAddress(opts.user)
    .storeMaybeRef(null)
    .storeCoins(forwardTon)
    .storeUint(OP.DEPOSIT, 32)
    .storeAddress(opts.user)
    .endCell();
}

// plain TEP-74 transfer with no forward payload; used to move underlying into the router vault
export function buildTransfer(opts: {
  amount: bigint;
  to: Address;
  responseTo: Address;
  forwardTon?: bigint;
  queryId?: bigint;
}): Cell {
  return beginCell()
    .storeUint(OP.TRANSFER, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeCoins(opts.amount)
    .storeAddress(opts.to)
    .storeAddress(opts.responseTo)
    .storeMaybeRef(null)
    .storeCoins(opts.forwardTon ?? 0n)
    .endCell();
}

export function buildHarvest(lpToBurn: bigint, gross: bigint, vault: Address, queryId = 0n): Cell {
  return beginCell()
    .storeUint(OP.HARVEST_STONFI, 32)
    .storeUint(queryId, 64)
    .storeCoins(lpToBurn)
    .storeCoins(gross)
    .storeAddress(vault)
    .endCell();
}

export const buildCommit = (commitHash: bigint, queryId = 0n): Cell =>
  beginCell().storeUint(OP.COMMIT, 32).storeUint(queryId, 64).storeUint(commitHash, 256).endCell();

export const buildReveal = (secret: bigint, queryId = 0n): Cell =>
  beginCell().storeUint(OP.REVEAL, 32).storeUint(queryId, 64).storeUint(secret, 256).endCell();

export const buildAdvanceEpoch = (queryId = 0n): Cell =>
  beginCell().storeUint(OP.ADVANCE_EPOCH, 32).storeUint(queryId, 64).endCell();

export const buildSettleDraw = (queryId = 0n): Cell =>
  beginCell().storeUint(OP.SETTLE_DRAW, 32).storeUint(queryId, 64).endCell();

// mirrors clients/quote.py harvest_plan: pick the integer LP burn whose underlying equals the
// accrued yield, then recompute the real release for that burn so reported gross == what moves.
export type Quote = { reserve: bigint; lpSupply: bigint };
export type Adapter = { principal: bigint; lpBalance: bigint };

export function harvestAmounts(a: Adapter, q: Quote): { lpToBurn: bigint; gross: bigint } {
  if (q.lpSupply === 0n || q.reserve === 0n) return { lpToBurn: 0n, gross: 0n };
  const lpValue = (a.lpBalance * q.reserve) / q.lpSupply;
  const accrued = lpValue > a.principal ? lpValue - a.principal : 0n;
  if (accrued === 0n) return { lpToBurn: 0n, gross: 0n };
  let lpToBurn = (accrued * q.lpSupply) / q.reserve;
  if (lpToBurn > a.lpBalance) lpToBurn = a.lpBalance;
  const gross = (lpToBurn * q.reserve) / q.lpSupply;
  return { lpToBurn, gross };
}

// 6-decimal jUSDT amounts; varied for a non-trivial leaderboard, each within one faucet drip (1000)
export const DEMO_DECIMALS = 6;
export function depositSchedule(count: number): bigint[] {
  const base = [400n, 1000n, 700n, 250n, 550n];
  const unit = 10n ** BigInt(DEMO_DECIMALS);
  return Array.from({ length: count }, (_, i) => base[i % base.length] * unit);
}