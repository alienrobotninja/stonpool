import {
  Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Dictionary, Sender, toNano,
} from '@ton/core';
import { OP, SROLE } from './protocol';

// Passing poolCore seeds it into the wiring map at deploy time. Since poolCore's own
// address is deployment-scoped (its init carries genesis), this makes the adapter address
// change every redeploy too, so a redeploy always lands a fresh, zero-state adapter instead
// of colliding with a prior instance and inheriting its principal/lpBalance. Omit it and
// the map is empty (byte-identical to the old storeBit(false)) for the sandbox specs.
export function yieldAdapterStonfiData(admin: Address, poolCore?: Address): Cell {
  const wiring = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Address());
  if (poolCore) wiring.set(SROLE.POOL_CORE, poolCore);
  return beginCell().storeAddress(admin).storeCoins(0).storeCoins(0).storeUint(0, 16).storeDict(wiring).endCell();
}

export class YieldAdapterStonfi implements Contract {
  constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

  static createFromConfig(admin: Address, code: Cell, workchain = 0) {
    const init = { code, data: yieldAdapterStonfiData(admin) };
    return new YieldAdapterStonfi(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }

  async sendConfigure(provider: ContractProvider, via: Sender, role: number, addr: Address) {
    await provider.internal(via, {
      value: toNano('0.1'),
      body: beginCell().storeUint(OP.CFG_STONFI_ADAPTER, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell(),
    });
  }

  async getAdapterData(provider: ContractProvider) {
    const s = (await provider.get('get_adapter_data', [])).stack;
    s.readAddress();
    return { principal: s.readBigNumber(), lpBalance: s.readBigNumber() };
  }
}