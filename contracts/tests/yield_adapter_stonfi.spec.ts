import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_CONFIGURE = 0x10000074;
const ERR_UNAUTHORIZED = 401;

const ROLE = { POOL_CORE: 0, OWN_WALLET: 1, ROUTER: 2, LP_WALLET: 3, STONFI_POOL: 4 };

class Adapter implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender) {
    await provider.internal(via, { value: 200_000_000n, body: beginCell().endCell() });
  }
  async sendConfigure(provider: ContractProvider, via: Sender, role: number, addr: Address) {
    await provider.internal(via, {
      value: 100_000_000n,
      body: beginCell().storeUint(OP_CONFIGURE, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell(),
    });
  }
  async getData(provider: ContractProvider) {
    const s = (await provider.get('get_adapter_data', [])).stack;
    return {
      admin: s.readAddress(),
      principal: s.readBigNumber(),
      lpBalance: s.readBigNumber(),
      poolCore: s.readAddressOpt(),
      ownWallet: s.readAddressOpt(),
      router: s.readAddressOpt(),
      lpWallet: s.readAddressOpt(),
      stonfiPool: s.readAddressOpt(),
    };
  }
  async getDeployedValue(provider: ContractProvider) {
    const s = (await provider.get('get_deployed_value', [])).stack;
    return { principal: s.readBigNumber(), yield: s.readBigNumber() };
  }
  async getLpBalance(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_lp_balance', [])).stack.readBigNumber();
  }
}

describe('C6 stonfi adapter surface (S3)', () => {
  let bc: Blockchain;
  let admin: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let poolCore: SandboxContract<TreasuryContract>;
  let ownWallet: SandboxContract<TreasuryContract>;
  let router: SandboxContract<TreasuryContract>;
  let lpWallet: SandboxContract<TreasuryContract>;
  let stonfiPool: SandboxContract<TreasuryContract>;
  let adapter: SandboxContract<Adapter>;

  async function setup() {
    bc = await Blockchain.create();
    admin = await bc.treasury('admin');
    stranger = await bc.treasury('stranger');
    poolCore = await bc.treasury('poolCore');
    ownWallet = await bc.treasury('ownWallet');
    router = await bc.treasury('router');
    lpWallet = await bc.treasury('lpWallet');
    stonfiPool = await bc.treasury('stonfiPool');

    const code = loadCode('yield_adapter_stonfi');
    const data = beginCell().storeAddress(admin.address).storeCoins(0).storeCoins(0).storeBit(false).endCell();
    const init = { code, data };
    adapter = bc.openContract(new Adapter(contractAddress(0, init), init));
    await adapter.sendDeploy(admin.getSender());
  }

  async function wireAll() {
    await adapter.sendConfigure(admin.getSender(), ROLE.POOL_CORE, poolCore.address);
    await adapter.sendConfigure(admin.getSender(), ROLE.OWN_WALLET, ownWallet.address);
    await adapter.sendConfigure(admin.getSender(), ROLE.ROUTER, router.address);
    await adapter.sendConfigure(admin.getSender(), ROLE.LP_WALLET, lpWallet.address);
    await adapter.sendConfigure(admin.getSender(), ROLE.STONFI_POOL, stonfiPool.address);
  }

  it('configure wires every role and reads back', async () => {
    await setup();
    await wireAll();
    const d = await adapter.getData();
    expect(d.admin.equals(admin.address)).toBe(true);
    expect(d.principal).toBe(0n);
    expect(d.lpBalance).toBe(0n);
    expect(d.poolCore!.equals(poolCore.address)).toBe(true);
    expect(d.ownWallet!.equals(ownWallet.address)).toBe(true);
    expect(d.router!.equals(router.address)).toBe(true);
    expect(d.lpWallet!.equals(lpWallet.address)).toBe(true);
    expect(d.stonfiPool!.equals(stonfiPool.address)).toBe(true);
  });

  it('reconfiguring a role overwrites it', async () => {
    await setup();
    await adapter.sendConfigure(admin.getSender(), ROLE.ROUTER, router.address);
    await adapter.sendConfigure(admin.getSender(), ROLE.ROUTER, stranger.address);
    const d = await adapter.getData();
    expect(d.router!.equals(stranger.address)).toBe(true);
  });

  it('unset roles read back as null', async () => {
    await setup();
    await adapter.sendConfigure(admin.getSender(), ROLE.POOL_CORE, poolCore.address);
    const d = await adapter.getData();
    expect(d.poolCore!.equals(poolCore.address)).toBe(true);
    expect(d.router).toBeNull();
    expect(d.lpWallet).toBeNull();
  });

  it('configure from a non-admin sender reverts (401)', async () => {
    await setup();
    const res = await adapter.sendConfigure(stranger.getSender(), ROLE.ROUTER, router.address);
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false, exitCode: ERR_UNAUTHORIZED });
  });

  it('reads report empty position before any deposit', async () => {
    await setup();
    await wireAll();
    const dv = await adapter.getDeployedValue();
    expect(dv.principal).toBe(0n);
    expect(dv.yield).toBe(0n);
    expect(await adapter.getLpBalance()).toBe(0n);
  });
});