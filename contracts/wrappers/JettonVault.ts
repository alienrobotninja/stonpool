import {
  Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, toNano,
} from '@ton/core';
import { OP } from './protocol';

export function jettonVaultData(admin: Address): Cell {
  return beginCell().storeAddress(admin).storeAddress(null).storeAddress(null).storeCoins(0).endCell();
}

export class JettonVault implements Contract {
  constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

  static createFromConfig(admin: Address, code: Cell, workchain = 0) {
    const init = { code, data: jettonVaultData(admin) };
    return new JettonVault(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }

  async sendConfigure(provider: ContractProvider, via: Sender, poolCore: Address, vaultWallet: Address) {
    await provider.internal(via, {
      value: toNano('0.1'),
      body: beginCell().storeUint(OP.CONFIGURE_VAULT, 32).storeUint(0, 64).storeAddress(poolCore).storeAddress(vaultWallet).endCell(),
    });
  }

  async getPot(provider: ContractProvider): Promise<bigint> {
    const s = (await provider.get('get_vault_data', [])).stack;
    s.readAddress(); s.readAddressOpt(); s.readAddressOpt();
    return s.readBigNumber();
  }
}