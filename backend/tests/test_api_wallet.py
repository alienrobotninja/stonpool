from app.api.deps import get_chain_client
from tests._chain import FakeGetMethodClient

OWNER = "0:" + "11" * 32
JETTON_WALLET = "0:" + "22" * 32


async def test_wallet_balance(app, client):
    fake = FakeGetMethodClient(
        {"get_wallet_data": [12345, None, None, None]}, wallet_address=JETTON_WALLET
    )
    app.dependency_overrides[get_chain_client] = lambda: fake

    r = await client.get(f"/wallet/{OWNER}")
    assert r.status_code == 200
    body = r.json()
    assert body["owner"] == OWNER
    assert body["jetton_wallet"] == JETTON_WALLET
    assert body["balance"] == 12345


async def test_wallet_balance_zero_when_wallet_undeployed(app, client):
    # no get_wallet_data entry -> the reader's get_wallet_data call raises -> balance 0
    fake = FakeGetMethodClient({}, wallet_address=JETTON_WALLET)
    app.dependency_overrides[get_chain_client] = lambda: fake

    r = await client.get(f"/wallet/{OWNER}")
    assert r.status_code == 200 and r.json()["balance"] == 0