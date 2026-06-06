import { Address, beginCell, Cell, Contract, ContractProvider, Sender, toNano } from '@ton/core';

export const DRIP = 1000n * 10n ** 6n; // 1000 tokens at 6 decimals
export const MINT_VALUE = toNano('0.2');
export const COOLDOWN = 3600;
export const FAUCET_FUNDING = toNano('1'); // ~2 drips; refill by sending TON to the faucet

const OP_CONFIGURE = 0x10000053;
const OP_REQUEST = 0x10000052;

export function offchainContent(uri: string): Cell {
  return beginCell().storeUint(1, 8).storeStringTail(uri).endCell();
}
export function faucetData(admin: Address): Cell {
  return beginCell()
    .storeAddress(admin).storeAddress(null).storeAddress(null)
    .storeCoins(DRIP).storeCoins(MINT_VALUE).storeUint(COOLDOWN, 32).storeBit(false)
    .endCell();
}
export function minterData(admin: Address, content: Cell, walletCode: Cell): Cell {
  return beginCell().storeCoins(0).storeAddress(admin).storeRef(content).storeRef(walletCode).endCell();
}
export function walletData(balance: bigint, owner: Address, minter: Address): Cell {
  return beginCell().storeCoins(balance).storeAddress(owner).storeAddress(minter).endCell();
}

export class MockStackContract implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }
  async sendConfigure(provider: ContractProvider, via: Sender, usdt: Address, usdc: Address) {
    await provider.internal(via, {
      value: toNano('0.1'),
      body: beginCell().storeUint(OP_CONFIGURE, 32).storeUint(0, 64).storeAddress(usdt).storeAddress(usdc).endCell(),
    });
  }
  async sendRequest(provider: ContractProvider, via: Sender) {
    await provider.internal(via, { value: toNano('0.3'), body: beginCell().storeUint(OP_REQUEST, 32).storeUint(0, 64).endCell() });
  }
}