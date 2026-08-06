import { readFileSync } from 'fs';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, Cell, beginCell, contractAddress, internal, toNano, SendMode } from '@ton/core';
import { ROLE, SROLE } from '../wrappers/protocol';
import { poolCoreData } from '../wrappers/PoolCore';
import { yieldAdapterStonfiData } from '../wrappers/YieldAdapterStonfi';
import { jettonVaultData } from '../wrappers/JettonVault';
import { drawEngineData } from '../wrappers/DrawEngine';
import { paramGovernorData } from '../wrappers/ParamGovernor';
import { mockStonfiRouterData } from '../wrappers/MockStonfiRouter';
import { mockStonfiPoolData } from '../wrappers/MockStonfiPool';
import { buildPlan } from './stonpoolPlan';
import { writeRegistry } from './addresses';

const OP = {
  CONFIGURE_VAULT: 0x10000072, CONFIGURE_CORE: 0x10000073,
  CFG_STONFI_ADAPTER: 0x10000074, CFG_ROUTER: 0x7e571001, CFG_POOL: 0x7e571002,
};

const MINTER = Address.parse('0:35641705ecea9f16147e51e462ccd4a3c44f32bd4cb98e1d11bc3edf4fd10898');
const FAUCET = Address.parse('0:fd9304b1b6a48095946e03f453adab8ff200a0ca68dbf2370ec7f6ff1001fe9b');

const env = readFileSync('.env', 'utf8');
const mnemonic = env.match(/WALLET_MNEMONIC=(.+)/)[1].trim().split(/\s+/);
const apiKey = env.match(/TONCENTER_TESTNET_KEY=(.+)/)?.[1]?.trim();
const load = (n) => Cell.fromBoc(Buffer.from(JSON.parse(readFileSync(`build/${n}.compiled.json`, 'utf8')).hex, 'hex'))[0];

// The adapter funds the provide chain from its OWN balance - PROVIDE_VALUE (1 TON) per
// deposit against the DEPOSIT_FWD_TON (0.05) the notify carries in, so 0.97 has to be
// resident per deposit and the seed burst fires all twelve in one wallet tx. Under-fund it
// and every notify books principal, fails to send the provide, and reverts the booking,
// leaving the jettons unbooked in its wallet while pool-core still counts them. This clears
// the burst with margin; the seeder tops up on demand for larger fields. Nothing ever sends
// TON back out of the adapter, so oversizing locks it there for good.
const ADAPTER_RESERVE = toNano('15');

const VALUE = {
  poolCore: toNano('0.3'), adapter: ADAPTER_RESERVE, vault: toNano('0.15'),
  drawEngine: toNano('0.15'), governor: toNano('0.15'), router: toNano('0.15'), stonfiPool: toNano('0.2'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// toncenter blips: a single 30s timeout mid-deploy used to crash the whole run, and since
// genesis is per-run, the retry would orphan the half-deployed stack. Retry the idempotent
// RPCs so one invocation rides through transient errors and finishes end-to-end, keeping
// genesis (and the deposit-window timing) fresh.
const isTransient = (e) =>
  e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT' || e?.code === 'ECONNRESET' ||
  /timeout|socket hang up|network|EAI_AGAIN/i.test(e?.message ?? '') ||
  e?.response?.status === 429 || e?.response?.status >= 500;

async function rpc(label, fn, tries = 6) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (!isTransient(e) || i >= tries) throw e;
      console.log(`  retry ${i}/${tries - 1} ${label}: ${e?.code ?? e?.message}`);
      await sleep(2500 * i);
    }
  }
}

async function main() {
  const c = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const w = c.open(WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }));
  const admin = w.address;
  console.log('deployer', admin.toString({ testOnly: true, bounceable: false }), Number(await rpc('balance', () => c.getBalance(admin))) / 1e9, 'TON');

  const codes = {
    poolCore: load('PoolCore'), adapter: load('YieldAdapterStonfi'), vault: load('JettonVault'),
    drawEngine: load('DrawEngine'), governor: load('ParamGovernor'), router: load('MockStonfiRouter'),
    stonfiPool: load('MockStonfiPool'), wallet: load('MockJettonWallet'),
  };
  const genesis = Math.floor(Date.now() / 1000);
  const plan = buildPlan({ admin, minter: MINTER, genesis, epoch: 1, demo: true, codes });
  const cfg = plan.config;
  const cr = plan.core;

  const inits = {
    poolCore: { code: codes.poolCore, data: poolCoreData({ epoch: 1, genesis, admin, config: cfg }) },
    adapter: { code: codes.adapter, data: yieldAdapterStonfiData(admin, cr.poolCore) },
    vault: { code: codes.vault, data: jettonVaultData(admin, genesis) },
    router: { code: codes.router, data: mockStonfiRouterData(admin, genesis) },
    stonfiPool: { code: codes.stonfiPool, data: mockStonfiPoolData(admin, codes.wallet, genesis) },
    drawEngine: { code: codes.drawEngine, data: drawEngineData({ poolCore: cr.poolCore, commitWindow: cfg.commitWindow, revealWindow: cfg.revealWindow, drawBond: cfg.drawBond }) },
    governor: { code: codes.governor, data: paramGovernorData({ admin, poolCore: cr.poolCore, timelockDelay: plan.timelock, config: cfg }) },
  };

  // fetch a fresh seqno per send, fire, then poll until it advances. a transient send error
  // is not fatal: the tx may still have landed, so we fall through to the poll rather than crash.
  const send = async (label, to, value, body, init) => {
    console.log('>', label);
    const prev = await rpc('seqno ' + label, () => w.getSeqno());
    try {
      await w.sendTransfer({ seqno: prev, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY, messages: [internal({ to, value, body, init, bounce: false })] });
    } catch (e) {
      if (!isTransient(e)) throw e;
      console.log(`  ${label} send errored (${e?.code ?? 'net'}); polling to see if it landed`);
    }
    for (let i = 0; i < 40; i++) {
      await sleep(3000);
      if (await rpc('confirm ' + label, () => w.getSeqno()) > prev) return;
    }
    throw new Error('seqno stuck at ' + label);
  };

  const order = ['poolCore', 'adapter', 'vault', 'router', 'stonfiPool', 'drawEngine', 'governor'];
  for (const name of order) {
    const a = contractAddress(0, inits[name]);
    if ((await rpc('state ' + name, () => c.getContractState(a))).state === 'active') { console.log('= deployed', name); continue; }
    await send('deploy ' + name, a, VALUE[name], beginCell().endCell(), inits[name]);
  }

  const wl = plan.wallets;
  const core = (role, addr) => beginCell().storeUint(OP.CONFIGURE_CORE, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell();
  const sad = (role, addr) => beginCell().storeUint(OP.CFG_STONFI_ADAPTER, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell();

  await send('wire vault', cr.vault, toNano('0.1'), beginCell().storeUint(OP.CONFIGURE_VAULT, 32).storeUint(0, 64).storeAddress(cr.poolCore).storeAddress(wl.vaultWallet).endCell());
  await send('core jetton-wallet', cr.poolCore, toNano('0.1'), core(ROLE.JETTON_WALLET, wl.poolWallet));
  await send('core adapter', cr.poolCore, toNano('0.1'), core(ROLE.ADAPTER, cr.adapter));
  await send('core draw-engine', cr.poolCore, toNano('0.1'), core(ROLE.DRAW_ENGINE, cr.drawEngine));
  await send('core vault', cr.poolCore, toNano('0.1'), core(ROLE.VAULT, cr.vault));
  await send('core governor', cr.poolCore, toNano('0.1'), core(ROLE.GOVERNOR, cr.governor));
  await send('adapter pool-core', cr.adapter, toNano('0.1'), sad(SROLE.POOL_CORE, cr.poolCore));
  await send('adapter own-wallet', cr.adapter, toNano('0.1'), sad(SROLE.OWN_WALLET, wl.adapterWallet));
  await send('adapter router', cr.adapter, toNano('0.1'), sad(SROLE.ROUTER, cr.router));
  await send('adapter lp-wallet', cr.adapter, toNano('0.1'), sad(SROLE.LP_WALLET, wl.adapterLpWallet));
  await send('adapter stonfi-pool', cr.adapter, toNano('0.1'), sad(SROLE.STONFI_POOL, cr.stonfiPool));
  await send('wire router', cr.router, toNano('0.1'), beginCell().storeUint(OP.CFG_ROUTER, 32).storeUint(0, 64).storeAddress(wl.routerWallet).storeAddress(cr.stonfiPool).endCell());
  await send('wire stonfi-pool', cr.stonfiPool, toNano('0.1'), beginCell().storeUint(OP.CFG_POOL, 32).storeUint(0, 64).storeAddress(cr.router).endCell());

  const path = writeRegistry('testnet', MINTER, plan, FAUCET);
  console.log('registry', path);
  console.log('poolCore', cr.poolCore.toString({ testOnly: true }));
}

main();