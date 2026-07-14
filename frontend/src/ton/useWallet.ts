import { useTonAddress, useTonConnectUI } from "@tonconnect/ui-react";
import { Address } from "@ton/core";

export interface SendMessage {
  address: string;
  amount: string;
  payload?: string;
}

export interface Wallet {
  address: string;
  rawAddress: string;
  connected: boolean;
  connect: () => void;
  disconnect: () => Promise<void>;
  send: (messages: SendMessage[]) => Promise<void>;
}

// TonConnect rejects raw 0:hex; normalize any address to TEP-2 friendly (testnet, bounceable)
function toFriendly(a: string): string {
  const addr = a.includes(":") ? Address.parseRaw(a) : Address.parse(a);
  return addr.toString({ urlSafe: true, bounceable: true, testOnly: true });
}

export function useWallet(): Wallet {
  const friendly = useTonAddress(true);
  const raw = useTonAddress(false);
  const [tonConnectUI] = useTonConnectUI();
  return {
    address: friendly,
    rawAddress: raw,
    connected: Boolean(friendly),
    connect: () => tonConnectUI.openModal(),
    disconnect: () => tonConnectUI.disconnect(),
    send: async (messages) => {
      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 180,
        messages: messages.map((m) => ({ ...m, address: toFriendly(m.address) })),
      });
    },
  };
}
