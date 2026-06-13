from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.repositories import EventRepo, StateRepo


def get_state_repo(db: Annotated[AsyncSession, Depends(get_db)]) -> StateRepo:
    return StateRepo(db)


def get_event_repo(db: Annotated[AsyncSession, Depends(get_db)]) -> EventRepo:
    return EventRepo(db)


StateRepoDep = Annotated[StateRepo, Depends(get_state_repo)]
EventRepoDep = Annotated[EventRepo, Depends(get_event_repo)]
