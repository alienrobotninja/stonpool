import { readFileSync } from 'fs';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { internal, toNano, SendMode } from '@ton/core';

// Measures the round-trip a keeper actually faces: submit a state-changing tx, then poll
// the RPC until it reflects the change. This is the number that has to be well under the
// commit/reveal windows, or every draw orphans at the boundary (HANDOFF section 8). Run
// against the same endpoint the keeper uses. 5 samples, reports min/median/max seconds.

const SAMPLES = 5;

const env = readFileSync('.env', 'utf8');
const mnemonic = env.match(/WALLET_MNEMONIC=(.+)/)![1].trim().split(/\s+/);
const apiKey = env.match(/TONCENTER_TESTNET_KEY=(.+)/)?.[1]?.trim();
const endpoint = env.match(/TONCENTER_TESTNET_ENDPOINT=(.+)/)?.[1]?.trim()
  ?? 'https://testnet.toncenter.com/api/v2/jsonRPC';

async function main() {
  const c = new TonClient({ endpoint, apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const w = c.open(WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }));
  console.log('endpoint', endpoint);
  console.log('wallet', w.address.toString({ testOnly: true, bounceable: false }));

  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const seqno = await w.getSeqno();
    const t0 = Date.now();
    // 0-value self-transfer: cheapest state change that bumps seqno
    await w.sendTransfer({
      seqno, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [internal({ to: w.address, value: toNano('0.02'), bounce: false })],
    });
    while (Date.now() - t0 < 900_000) {
      await new Promise(r => setTimeout(r, 1000));
      if (await w.getSeqno() > seqno) break;
    }
    const lag = (Date.now() - t0) / 1000;
    samples.push(lag);
    console.log(`sample ${i + 1}/${SAMPLES}: ${lag.toFixed(1)}s`);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`\nmin ${sorted[0].toFixed(1)}s  median ${median.toFixed(1)}s  max ${sorted[sorted.length - 1].toFixed(1)}s`);
  console.log(median <= 90
    ? 'OK: DEMO_CONFIG 120s windows have margin. Deploy as-is.'
    : 'TOO SLOW for a sped-up demo: reduce lag at the endpoint (see notes) before redeploy.');
}

main();