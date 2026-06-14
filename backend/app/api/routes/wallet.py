from fastapi import APIRouter

from app.api.deps import ChainClientDep, SettingsDep
from app.api.schemas import WalletBalanceOut
from app.clients import read_jetton_balance

router = APIRouter(tags=["wallet"])


@router.get("/wallet/{address}", response_model=WalletBalanceOut)
async def wallet(address: str, client: ChainClientDep, cfg: SettingsDep) -> WalletBalanceOut:
    jetton_wallet, balance = await read_jetton_balance(client, cfg.jetton_master_address, address)
    return WalletBalanceOut(owner=address, jetton_wallet=jetton_wallet, balance=balance)