import sqlite3
from pathlib import Path

from alembic.config import Config

from alembic import command

ROOT = Path(__file__).resolve().parents[1]
TABLES = {
    "deposits",
    "withdrawals",
    "harvests",
    "payouts",
    "pool_snapshots",
    "epochs",
    "depositor_positions",
    "draws",
    "indexer_cursors",
}


def _cfg(db_path: Path) -> Config:
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite+aiosqlite:///{db_path}")
    return cfg


def _names(db_path: Path) -> set[str]:
    con = sqlite3.connect(db_path)
    try:
        return {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
    finally:
        con.close()


def test_upgrade_head_creates_all_tables(tmp_path):
    db = tmp_path / "m.db"
    command.upgrade(_cfg(db), "head")
    assert TABLES <= _names(db)


def test_downgrade_base_drops_tables(tmp_path):
    db = tmp_path / "m.db"
    cfg = _cfg(db)
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "base")
    assert TABLES.isdisjoint(_names(db))
