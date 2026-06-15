import { Address, beginCell, Cell, contractAddress, Sender, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { mnemonicToWalletKey } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';
import { walletData } from '../wrappers/mockStack';
import { buildDeposit, buildFaucetClaim, depositSchedule } from './demo';

type Actor = { address: Address; sender: Sender };

function envAddr(args: string[], name: string): Address {
  const positional = args.find((a) => !a.startsWith('--'));
  const raw = positional ?? process.env[name];
  if (!raw) throw new Error(`set ${name} (or pass as an arg)`);
  return Address.parse(raw);
}

async function actors(provider: NetworkProvider): Promise<Actor[]> {
  const out: Actor[] = [{ address: provider.sender().address!, sender: provider.sender() }];
  const phrases = (process.env.DEMO_MNEMONICS ?? '').split(';').map((p) => p.trim()).filter(Boolean);
  for (const phrase of phrases) {
    const key = await mnemonicToWalletKey(phrase.split(/\s+/));
    const wallet = provider.open(WalletContractV4.create({ workchain: 0, publicKey: key.publicKey }));
    out.push({ address: wallet.address, sender: wallet.sender(key.secretKey) });
  }
  return out;
}

async function jettonBalance(provider: NetworkProvider, wallet: Address): Promise<bigint> {
  try {
    return (await provider.provider(wallet).get('get_wallet_data', [])).stack.readBigNumber();
  } catch {
    return 0n;
  }
}

async function waitForBalance(provider: NetworkProvider, wallet: Address, min: bigint) {
  for (let i = 0; i < 40; i++) {
    if ((await jettonBalance(provider, wallet)) >= min) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`jetton balance for ${wallet.toRawString()} did not reach ${min}`);
}

export async function run(provider: NetworkProvider, args: string[] = []) {
  const ui = provider.ui();
  const minter = envAddr(args, 'JETTON_MINTER');
  const pool = Address.parse(process.env.STONPOOL_POOL_CORE_ADDRESS ?? args[1] ?? '');
  const faucet = Address.parse(process.env.FAUCET_ADDRESS ?? args[2] ?? '');
  const walletCode = await compile('MockJettonWallet');
  const walletOf = (owner: Address, m: Address) =>
    contractAddress(0, { code: walletCode, data: walletData(0n, owner, m) });

  const list = await actors(provider);
  const amounts = depositSchedule(list.length);
  const deployer = provider.sender();

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const amount = amounts[i];
    ui.write(`\n[${i + 1}/${list.length}] ${a.address.toRawString()} depositing ${amount}`);

    if (!a.address.equals(deployer.address!)) {
      await deployer.send({ to: a.address, value: toNano('0.6'), bounce: false });
    }

    const jWallet = walletOf(a.address, minter);
    if ((await jettonBalance(provider, jWallet)) < amount) {
      ui.write('  claiming faucet');
      await a.sender.send({ to: faucet, value: toNano('0.3'), body: buildFaucetClaim() });
      await waitForBalance(provider, jWallet, amount);
    }

    ui.write('  depositing');
    const body: Cell = buildDeposit({ amount, pool, user: a.address });
    await a.sender.send({ to: jWallet, value: toNano('0.7'), body });
  }

  ui.write('\nseed complete; positions should appear after the next indexer poll');
}
