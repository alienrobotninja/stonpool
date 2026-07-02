import base64
import sys
import types

import pytest
from pytoniq_core import begin_cell

from app.keeper.wallet_sender import WalletSender


def test_mnemonic_must_be_24_words():
    with pytest.raises(ValueError):
        WalletSender(object(), ["word"] * 23)


async def test_signs_offline_and_broadcasts_the_boc(monkeypatch):
    # fake only pytoniq.WalletV5R1 + the key derivation; pytoniq_core (Address/Cell) is real.
    # this pins the interface wallet_sender depends on so a pytoniq bump that breaks it fails here.
    captured: dict = {}

    class FakeBoc:
        def to_boc(self):
            return b"\x01\x02\x03"

    class FakeExt:
        def serialize(self):
            return FakeBoc()

    class FakeWallet:
        @classmethod
        async def from_private_key(cls, *, provider, private_key, wc):
            captured["provider"] = provider
            captured["wc"] = wc
            return cls()

        async def create_transfer_msg(self, *, destination, amount, body):
            captured["dest"] = str(destination)
            captured["amount"] = amount
            return FakeExt()

    fake = types.ModuleType("pytoniq")
    fake.WalletV5R1 = FakeWallet
    monkeypatch.setitem(sys.modules, "pytoniq", fake)
    derive = "pytoniq_core.crypto.keys.mnemonic_to_private_key"
    monkeypatch.setattr(derive, lambda m: (b"pub", b"priv"))

    class FakeClient:
        def __init__(self):
            self.boc = None

        async def send_boc(self, b64):
            self.boc = b64
            return "tx-hash"

    client = FakeClient()
    sender = WalletSender(client, ["w"] * 24, workchain=0)
    tx = await sender.send(to="0:" + "aa" * 32, body=begin_cell().end_cell(), value=250_000_000)

    assert tx == "tx-hash"
    assert client.boc == base64.b64encode(b"\x01\x02\x03").decode()
    assert captured["amount"] == 250_000_000
    assert captured["provider"] is client