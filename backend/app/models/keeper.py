from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import Seed


class KeeperSecret(Base):
    # commit-reveal secret persisted so a keeper restart between commit and reveal does
    # not lose the bonded secret (which would slash the bond and abort the draw).
    __tablename__ = "keeper_secrets"

    epoch: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    secret: Mapped[str] = mapped_column(Seed)  # 0x + 64 hex
    commit_hash: Mapped[str] = mapped_column(Seed)
    revealed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
