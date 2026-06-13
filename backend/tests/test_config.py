from app.core.config import Settings, get_settings


def test_defaults():
    cfg = Settings()
    assert cfg.env in {"testnet", "mainnet"}
    assert cfg.database_url
    assert cfg.is_mainnet is False


def test_env_override(monkeypatch):
    monkeypatch.setenv("STONPOOL_ENV", "mainnet")
    get_settings.cache_clear()
    try:
        assert get_settings().is_mainnet is True
    finally:
        get_settings.cache_clear()
