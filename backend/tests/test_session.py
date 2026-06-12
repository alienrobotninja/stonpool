from sqlalchemy import text

import app.db.session as session_mod


async def test_session_select(db):
    r = await db.execute(text("select 1"))
    assert r.scalar_one() == 1


async def test_session_scope_commits(sm):
    async with session_mod.session_scope() as s:
        r = await s.execute(text("select 42"))
        assert r.scalar_one() == 42


async def test_get_db_yields_session(sm):
    gen = session_mod.get_db()
    s = await gen.__anext__()
    try:
        r = await s.execute(text("select 7"))
        assert r.scalar_one() == 7
    finally:
        await gen.aclose()