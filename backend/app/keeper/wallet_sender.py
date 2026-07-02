"""Concrete production TxSender. Review-only: not imported by the package __init__ and
not exercised in the sandbox (no chain, no signing keys). The runtime entrypoint (T1)
wires it. It signs a WalletV5R1 external message offline, then broadcasts the BoC via
toncenter, sidestepping liteserver flakiness.

The exact pytoniq calls below must be validated against the installed pytoniq version
when wiring T1; pytoniq is an optional runtime dependency, imported lazily so this module
stays importable for review without it.
"""

import base64

from pytoniq_core import Address, Cell

from app.clients.chain import ToncenterClient


class WalletSender:
    def __init__(self, client: ToncenterClient, mnemonic: list[str], *, workchain: int = 0):
        if len(mnemonic) != 24:
            raise ValueError(f"operator mnemonic must be 24 words, got {len(mnemonic)}")
        from pytoniq import WalletV5R1  # lazy
        from pytoniq_core.crypto.keys import mnemonic_to_private_key

        self.client = client
        self.workchain = workchain
        _, self._priv = mnemonic_to_private_key(mnemonic)
        self._WalletV5R1 = WalletV5R1

    async def _wallet(self):
        return await self._WalletV5R1.from_private_key(
            provider=self.client, private_key=self._priv, wc=self.workchain
        )

    async def send(self, *, to: str, body: Cell, value: int) -> str:
        wallet = await self._wallet()
        ext = await wallet.create_transfer_msg(destination=Address(to), amount=value, body=body)
        boc = ext.serialize().to_boc()
        return await self.client.send_boc(base64.b64encode(boc).decode())