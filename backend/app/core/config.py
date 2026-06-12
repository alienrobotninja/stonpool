from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="STONPOOL_", env_file=".env", extra="ignore")

    env: str = "testnet"  # testnet | mainnet
    database_url: str = "sqlite+aiosqlite:///./stonpool.db"

    # toncenter v3 access, used by the chain client from B6.S4 onward
    toncenter_base_url: str = "https://testnet.toncenter.com/api/v3"
    toncenter_api_key: str = ""

    db_echo: bool = False
    db_pool_size: int = 5

    @property
    def is_mainnet(self) -> bool:
        return self.env == "mainnet"


@lru_cache
def get_settings() -> Settings:
    return Settings()