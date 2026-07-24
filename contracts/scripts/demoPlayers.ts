import { Address } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';

// The demo field, derived once and shared by every script that touches it. Duplicating
// this would let the seeder and the verifier disagree about who the players are, which
// reads as "positions missing" rather than "two different address sets".

export const UNIT = 10n ** 6n; // jUSDT has 6 decimals

// Uneven on purpose: odds are weight-proportional, so a field of equal stakes demonstrates
// nothing. Total 710, which fits inside one 1000 faucet drip with room for the yield.
export const WEIGHTS = [25n, 30n, 35n, 40n, 45n, 50n, 55n, 60n, 70n, 80n, 100n, 120n];

// Players are subwallets of the operator key, so every position is one we hold keys for
// and can withdraw from later. Subwallet 0 is the operator's own wallet - the default
// WalletContractV5R1.create() - so the field starts at 1. networkGlobalId stays -239 to
// match the operator wallet; -3 derives a different, empty address.
export function derivePlayers(publicKey: Buffer, count = WEIGHTS.length): Address[] {
  return Array.from({ length: count }, (_, i) =>
    WalletContractV5R1.create({
      publicKey,
      walletId: { networkGlobalId: -239, context: { walletVersion: 'v5r1', workchain: 0, subwalletNumber: i + 1 } },
    }).address);
}

export function operatorAddress(publicKey: Buffer): Address {
  return WalletContractV5R1.create({ workchain: 0, publicKey }).address;
}