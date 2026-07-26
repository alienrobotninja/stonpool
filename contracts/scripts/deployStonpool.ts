import { Address, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { ROLE, SROLE } from '../wrappers/protocol';
import { PoolCore } from '../wrappers/PoolCore';
import { YieldAdapterStonfi } from '../wrappers/YieldAdapterStonfi';
import { JettonVault } from '../wrappers/JettonVault';
import { DrawEngine } from '../wrappers/DrawEngine';
import { ParamGovernor } from '../wrappers/ParamGovernor';
import { MockStonfiRouter } from '../wrappers/MockStonfiRouter';
import { MockStonfiPool } from '../wrappers/MockStonfiPool';
import { buildPlan, envBlock } from './stonpoolPlan';
import { writeRegistry } from './addresses';

const VALUE = {
  poolCore: toNano('0.3'),
  adapter: toNano('0.3'),
  vault: toNano('0.15'),
  drawEngine: toNano('0.15'),
  governor: toNano('0.15'),
  router: toNano('0.15'),
  stonfiPool: toNano('0.2'),
};

function resolveMinter(args: string[]): Address | null {
  const positional = args.find((a) => !a.startsWith('--'));
  const raw = positional ?? process.env.JETTON_MINTER;
  return raw ? Address.parse(raw) : null;
}

export async function run(provider: NetworkProvider, args: string[] = []) {
  const ui = provider.ui();
  const sender = provider.sender();
  const admin = sender.address!;
  const demo = args.includes('--demo');

  const minter =
    resolveMinter(args) ??
    Address.parse(await ui.input('Underlying jetton minter address (from deployMockStack):'));

  const codes = {
    poolCore: await compile('PoolCore'),
    adapter: await compile('YieldAdapterStonfi'),
    vault: await compile('JettonVault'),
    drawEngine: await compile('DrawEngine'),
    governor: await compile('ParamGovernor'),
    router: await compile('MockStonfiRouter'),
    stonfiPool: await compile('MockStonfiPool'),
    wallet: await compile('MockJettonWallet'),
  };

  const genesis = Math.floor(Date.now() / 1000);
  const plan = buildPlan({ admin, minter, genesis, epoch: 1, demo, codes });
  const c = plan.core;

  // seqno gate: wiring fires many messages from one wallet; wait for each to land before the next
  const seqno = async () => {
    try {
      return (await provider.provider(admin).get('seqno', [])).stack.readNumber();
    } catch {
      return 0;
    }
  };
  const step = async (label: string, fn: () => Promise<void>) => {
    ui.write(`> ${label}`);
    const before = await seqno();
    await fn();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      if ((await seqno()) > before) return;
    }
    ui.write(`  (warning: seqno did not advance for ${label})`);
  };

  const deploy = async (label: string, contract: any, value: bigint) => {
    const opened = provider.open(contract);
    if (await provider.isContractDeployed(opened.address)) {
      ui.write(`= ${label} already at ${opened.address.toRawString()}`);
      return opened;
    }
    ui.write(`+ deploying ${label}`);
    await opened.sendDeploy(sender, value);
    await provider.waitForDeploy(opened.address);
    return opened;
  };

  const poolCore = await deploy('pool-core', PoolCore.createFromConfig({ epoch: 1, genesis, admin, config: plan.config }, codes.poolCore), VALUE.poolCore);
  const adapter = await deploy('yield-adapter-stonfi', YieldAdapterStonfi.createFromConfig(admin, codes.adapter), VALUE.adapter);
  const vault = await deploy('jetton-vault', JettonVault.createFromConfig(admin, codes.vault, genesis), VALUE.vault);
  const router = await deploy('mock-stonfi-router', MockStonfiRouter.createFromConfig(admin, codes.router, genesis), VALUE.router);
  const stonfiPool = await deploy('mock-stonfi-pool', MockStonfiPool.createFromConfig(admin, codes.wallet, codes.stonfiPool, genesis), VALUE.stonfiPool);
  const drawEngine = await deploy('draw-engine', DrawEngine.createFromConfig({ poolCore: c.poolCore, commitWindow: plan.config.commitWindow, revealWindow: plan.config.revealWindow, drawBond: plan.config.drawBond }, codes.drawEngine), VALUE.drawEngine);
  const governor = await deploy('param-governor', ParamGovernor.createFromConfig({ admin, poolCore: c.poolCore, timelockDelay: plan.timelock, config: plan.config }, codes.governor), VALUE.governor);

  const w = plan.wallets;

  await step('wire vault', () => vault.sendConfigure(sender, c.poolCore, w.vaultWallet));
  await step('wire core jetton-wallet', () => poolCore.sendConfigureCore(sender, ROLE.JETTON_WALLET, w.poolWallet));
  await step('wire core adapter', () => poolCore.sendConfigureCore(sender, ROLE.ADAPTER, c.adapter));
  await step('wire core draw-engine', () => poolCore.sendConfigureCore(sender, ROLE.DRAW_ENGINE, c.drawEngine));
  await step('wire core vault', () => poolCore.sendConfigureCore(sender, ROLE.VAULT, c.vault));
  await step('wire core governor', () => poolCore.sendConfigureCore(sender, ROLE.GOVERNOR, c.governor));
  await step('wire adapter pool-core', () => adapter.sendConfigure(sender, SROLE.POOL_CORE, c.poolCore));
  await step('wire adapter own-wallet', () => adapter.sendConfigure(sender, SROLE.OWN_WALLET, w.adapterWallet));
  await step('wire adapter router', () => adapter.sendConfigure(sender, SROLE.ROUTER, c.router));
  await step('wire adapter lp-wallet', () => adapter.sendConfigure(sender, SROLE.LP_WALLET, w.adapterLpWallet));
  await step('wire adapter stonfi-pool', () => adapter.sendConfigure(sender, SROLE.STONFI_POOL, c.stonfiPool));
  await step('wire router', () => router.sendConfigure(sender, w.routerWallet, c.stonfiPool));
  await step('wire stonfi-pool', () => stonfiPool.sendConfigure(sender, c.router));

  const faucet = process.env.FAUCET ? Address.parse(process.env.FAUCET) : undefined;
  const registry = writeRegistry(provider.network(), minter, plan, faucet);
  if (!faucet) ui.write('note: set FAUCET to record the faucet in the registry');
  ui.write(`\ndeployed and wired. registry: ${registry}\n`);
  ui.write(envBlock(minter, plan));
}