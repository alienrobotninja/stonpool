import {
  Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, toNano,
} from '@ton/core';
import { OP, packConfig, poolSetup, PoolConfig } from './protocol';

export type PoolCoreConfig = {
  epoch: number;
  genesis: number; // unix ts the first epoch starts at
  admin: Address;
  config: PoolConfig;
  // Genesis derives this from the config, which is what a real deploy does. Specs that
  // park the deadline far out to keep it irrelevant pass it explicitly instead of
  // contorting their config to land on the value they want.
  depositDeadline?: number;
};

export function poolCoreData(c: PoolCoreConfig): Cell {
  const depositDeadline = c.depositDeadline ?? c.genesis + c.config.epochLength - c.config.depositCutoff;
  return beginCell()
    .storeUint(c.epoch, 32)
    .storeUint(depositDeadline, 32)
    .storeUint(c.genesis, 32)
    .storeCoins(0)
    .storeCoins(0)
    .storeBit(false) // drawOpen: no draw outstanding at genesis
    .storeUint(0, 64) // withdrawNonce
    .storeAddress(c.admin)
    .storeRef(poolSetup(packConfig(c.config))) // config + wiring, folded to keep the root under 4 refs
    .storeBit(false)
    .storeBit(false) // empty ledger + pending maps
    .endCell();
}

const addrArg = (a: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(a).endCell() });

export class PoolCore implements Contract {
  constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

  static createFromConfig(cfg: PoolCoreConfig, code: Cell, workchain = 0) {
    const init = { code, data: poolCoreData(cfg) };
    return new PoolCore(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }

  async sendConfigureCore(provider: ContractProvider, via: Sender, role: number, addr: Address) {
    await provider.internal(via, {
      value: toNano('0.1'),
      body: beginCell().storeUint(OP.CONFIGURE_CORE, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell(),
    });
  }

  async sendAdvanceEpoch(provider: ContractProvider, via: Sender, value = toNano('1')) {
    await provider.internal(via, { value, body: beginCell().storeUint(OP.ADVANCE_EPOCH, 32).storeUint(0, 64).endCell() });
  }

  async sendSettleDraw(provider: ContractProvider, via: Sender, value = toNano('1')) {
    await provider.internal(via, { value, body: beginCell().storeUint(OP.SETTLE_DRAW, 32).storeUint(0, 64).endCell() });
  }

  async getPoolData(provider: ContractProvider) {
    const s = (await provider.get('get_pool_data', [])).stack;
    return { epoch: s.readBigNumber(), depositDeadline: s.readBigNumber(), totalPrincipal: s.readBigNumber(), prizePot: s.readBigNumber() };
  }

  async getBalanceOf(provider: ContractProvider, who: Address) {
    const s = (await provider.get('get_balance_of', [addrArg(who)])).stack;
    return { weight: s.readBigNumber(), joinEpoch: s.readBigNumber() };
  }
}