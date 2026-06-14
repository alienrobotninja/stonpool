from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.clients import ChainClient, ToncenterClient
from app.core.config import Settings, get_settings
from app.db.session import get_db
from app.repositories import EventRepo, StateRepo


def get_cfg() -> Settings:
    return get_settings()


def get_state_repo(db: Annotated[AsyncSession, Depends(get_db)]) -> StateRepo:
    return StateRepo(db)


def get_event_repo(db: Annotated[AsyncSession, Depends(get_db)]) -> EventRepo:
    return EventRepo(db)


def get_chain_client(cfg: Annotated[Settings, Depends(get_cfg)]) -> ChainClient:
    return ToncenterClient(cfg)


SettingsDep = Annotated[Settings, Depends(get_cfg)]
StateRepoDep = Annotated[StateRepo, Depends(get_state_repo)]
EventRepoDep = Annotated[EventRepo, Depends(get_event_repo)]
ChainClientDep = Annotated[ChainClient, Depends(get_chain_client)]