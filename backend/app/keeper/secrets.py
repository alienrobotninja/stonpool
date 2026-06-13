import secrets as _secrets

from sqlalchemy.ext.asyncio import AsyncSession

from app.keeper.hashing import commit_hash
from app.models import KeeperSecret


def gen_secret() -> int:
    return _secrets.randbits(256)


def to_hex(v: int) -> str:
    return "0x" + format(v, "064x")


def from_hex(s: str) -> int:
    return int(s, 16)


class SecretStore:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(self, *, epoch: int, secret: int) -> KeeperSecret:
        row = await self.db.get(KeeperSecret, epoch)
        if row is None:
            row = KeeperSecret(
                epoch=epoch, secret=to_hex(secret), commit_hash=to_hex(commit_hash(secret))
            )
            self.db.add(row)
        return row

    async def get(self, epoch: int) -> KeeperSecret | None:
        return await self.db.get(KeeperSecret, epoch)

    async def mark_revealed(self, epoch: int) -> None:
        row = await self.db.get(KeeperSecret, epoch)
        if row is not None:
            row.revealed = True
