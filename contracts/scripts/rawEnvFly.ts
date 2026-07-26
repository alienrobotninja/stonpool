import { readFileSync } from 'fs';
import { registryPath } from './addresses';

// Emits the address secrets for .env.fly straight from the registry the deployer wrote.
// Every redeploy changes eight addresses and each one is a 64-character hex string; a single
// transposed character points the indexer at an account that does not exist and the api
// serves an empty dashboard with no error anywhere.

const KEYS: [string, string][] = [
  ['poolCore', 'STONPOOL_POOL_CORE_ADDRESS'],
  ['adapter', 'STONPOOL_ADAPTER_ADDRESS'],
  ['vault', 'STONPOOL_VAULT_ADDRESS'],
  ['drawEngine', 'STONPOOL_DRAW_ENGINE_ADDRESS'],
  ['governor', 'STONPOOL_GOVERNOR_ADDRESS'],
  ['router', 'STONPOOL_STONFI_ROUTER_ADDRESS'],
  ['stonfiPool', 'STONPOOL_STONFI_POOL_ADDRESS'],
  ['jettonMinter', 'STONPOOL_JETTON_MASTER_ADDRESS'],
];

const network = process.argv[2] ?? 'testnet';
const path = registryPath(network);
const reg = JSON.parse(readFileSync(path, 'utf8'));

console.log(`# from ${path}`);
const missing: string[] = [];
for (const [key, secret] of KEYS) {
  const v = reg[key];
  if (!v) { missing.push(key); continue; }
  console.log(`${secret}=${v}`);
}

if (reg.faucet) console.log(`# faucet ${reg.faucet}  (frontend VITE_FAUCET_ADDRESS)`);
if (missing.length) {
  console.error(`\nmissing from the registry: ${missing.join(', ')}`);
  process.exit(1);
}