import { Address, contractAddress, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { randomBytes } from 'crypto';
import { walletData } from '../wrappers/mockStack';
import { MockStonfiPool } from '../wrappers/MockStonfiPool';
import {
  buildAdvanceEpoch, buildCommit, buildFaucetClaim, buildHarvest, buildReveal, buildSettleDraw,
  buildTransfer, commitHashOf, harvestAmounts,
} from './demo';

const YIELD = 500n * 10n ** 6n; // jUSDT injected as swap-fee yield (within one faucet drip)

const env = (name: string): Address => {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return Address.parse(v);
};

const randSecret = (): bigint => BigInt('0x' + randomBytes(32).toString('hex'));

async function sleepUntil(ts: number, ui: { write: (s: string) => void }) {
  while (Math.floor(Date.now() / 1000) < ts) {
    ui.write(`  waiting ${ts - Math.floor(Date.now() / 1000)}s`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export async function run(provider: NetworkProvider, args: string[] = []) {
  const ui = provider.ui();
  const sender = provider.sender();
  const me = sender.address!;
  const demo = args.includes('--demo');
  const drawBond = demo ? toNano('0.2') : toNano('1');

  const minter = env('JETTON_MINTER');
  const pool = env('STONPOOL_POOL_CORE_ADDRESS');
  const adapter = env('STONPOOL_ADAPTER_ADDRESS');
  const vault = env('STONPOOL_VAULT_ADDRESS');
  const drawEngine = env('STONPOOL_DRAW_ENGINE_ADDRESS');
  const router = env('STONPOOL_STONFI_ROUTER_ADDRESS');
  const stonfiPool = env('STONPOOL_STONFI_POOL_ADDRESS');
  const faucet = env('FAUCET_ADDRESS');

  const walletCode = await compile('MockJettonWallet');
  const myJetton = contractAddress(0, { code: walletCode, data: walletData(0n, me, minter) });

  const num = async (addr: Address, method: string, skipAddr = 0) => {
    const s = (await provider.provider(addr).get(method, [])).stack;
    for (let i = 0; i < skipAddr; i++) s.readAddress();
    return s;
  };
  const jettonBalance = async (w: Address) => {
    try {
      return (await provider.provider(w).get('get_wallet_data', [])).stack.readBigNumber();
    } catch {
      return 0n;
    }
  };

  // 0. ensure the deployer holds enough jUSDT to inject as yield
  if ((await jettonBalance(myJetton)) < YIELD) {
    ui.write('claiming faucet for the operator');
    await sender.send({ to: faucet, value: toNano('0.3'), body: buildFaucetClaim() });
    for (let i = 0; i < 40 && (await jettonBalance(myJetton)) < YIELD; i++) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // 1. inject yield: move underlying into the router vault, then bump the pool reserve
  ui.write('injecting yield');
  await sender.send({ to: myJetton, value: toNano('0.5'), body: buildTransfer({ amount: YIELD, to: router, responseTo: me }) });
  await provider.open(new MockStonfiPool(stonfiPool)).sendAccrue(sender, YIELD);
  await new Promise((r) => setTimeout(r, 8000));

  // 2. harvest: burn LP for the accrued underlying and route it to the vault
  const aStack = await num(adapter, 'get_adapter_data', 1);
  const a = { principal: aStack.readBigNumber(), lpBalance: aStack.readBigNumber() };
  const qStack = await num(stonfiPool, 'get_lp_quote');
  const q = { reserve: qStack.readBigNumber(), lpSupply: qStack.readBigNumber() };
  const { lpToBurn, gross } = harvestAmounts(a, q);
  ui.write(`harvesting lp=${lpToBurn} gross=${gross}`);
  if (gross > 0n) {
    await sender.send({ to: adapter, value: toNano('0.2'), body: buildHarvest(lpToBurn, gross, vault) });
    await new Promise((r) => setTimeout(r, 8000));
  }

  // 3. advance the epoch -> opens the draw for the epoch that just ended
  ui.write('advancing epoch');
  await sender.send({ to: pool, value: toNano('0.15'), body: buildAdvanceEpoch() });
  await new Promise((r) => setTimeout(r, 8000));

  // 4. commit a bonded secret as the operator-committer
  const secret = randSecret();
  ui.write('committing');
  await sender.send({ to: drawEngine, value: drawBond + toNano('0.2'), body: buildCommit(commitHashOf(secret)) });

  // read the draw deadlines and respect the windows
  const ds = (await provider.provider(drawEngine).get('get_draw_state', [])).stack;
  ds.readBigNumber(); // epoch
  const commitDeadline = Number(ds.readBigNumber());
  const revealDeadline = Number(ds.readBigNumber());

  // 5. reveal once the commit window closes
  await sleepUntil(commitDeadline, ui);
  ui.write('revealing');
  await sender.send({ to: drawEngine, value: toNano('0.2'), body: buildReveal(secret) });

  // 6. settle once the reveal window closes -> draw finalizes and pays winners
  await sleepUntil(revealDeadline, ui);
  ui.write('settling');
  await sender.send({ to: pool, value: toNano('0.3'), body: buildSettleDraw() });

  ui.write('\ncycle complete; the keeper (or indexer) records the draw and payouts');
}