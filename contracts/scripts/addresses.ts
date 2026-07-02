import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { Address } from '@ton/core';
import { Plan } from './stonpoolPlan';

export type AddressRegistry = {
  network: string;
  jettonMinter: string;
  poolCore: string;
  adapter: string;
  vault: string;
  drawEngine: string;
  governor: string;
  router: string;
  stonfiPool: string;
  faucet?: string;
  wallets: { pool: string; adapter: string; adapterLp: string; vault: string; router: string };
};

const raw = (a: Address) => a.toRawString();

export function buildRegistry(network: string, minter: Address, plan: Plan, faucet?: Address): AddressRegistry {
  const c = plan.core;
  const w = plan.wallets;
  return {
    network,
    jettonMinter: raw(minter),
    poolCore: raw(c.poolCore),
    adapter: raw(c.adapter),
    vault: raw(c.vault),
    drawEngine: raw(c.drawEngine),
    governor: raw(c.governor),
    router: raw(c.router),
    stonfiPool: raw(c.stonfiPool),
    ...(faucet ? { faucet: raw(faucet) } : {}),
    wallets: {
      pool: raw(w.poolWallet),
      adapter: raw(w.adapterWallet),
      adapterLp: raw(w.adapterLpWallet),
      vault: raw(w.vaultWallet),
      router: raw(w.routerWallet),
    },
  };
}

export const registryPath = (network: string, dir = 'addresses') => join(dir, `${network}.json`);

export function writeRegistry(network: string, minter: Address, plan: Plan, faucet?: Address, dir = 'addresses'): string {
  const path = registryPath(network, dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(buildRegistry(network, minter, plan, faucet), null, 2) + '\n');
  return path;
}

export function loadRegistry(network: string, dir = 'addresses'): AddressRegistry {
  return JSON.parse(readFileSync(registryPath(network, dir), 'utf-8'));
}