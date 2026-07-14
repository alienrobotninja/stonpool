import { useTonAddress, useTonConnectUI } from "@tonconnect/ui-react";

export interface SendMessage {
  address: string;
  amount: string; // nanotons
  payload?: string; // base64 BoC
}

export interface Wallet {
  address: string; // user-friendly, "" when disconnected
  rawAddress: string; // raw 0:hex, "" when disconnected
  connected: boolean;
  connect: () => void;
  disconnect: () => Promise<void>;
  send: (messages: SendMessage[]) => Promise<void>;
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
        messages,
      });
    },
  };
}
