from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="STONPOOL_", env_file=".env", extra="ignore")

    env: str = "testnet"  # testnet | mainnet
    database_url: str = "sqlite+aiosqlite:///./stonpool.db"

    # toncenter v3 access, used by the chain client from B6.S4 onward
    toncenter_base_url: str = "https://testnet.toncenter.com/api/v3"
    toncenter_api_key: str = ""
    toncenter_min_interval: float = 0.12  # seconds between calls; the key is capped per second
    toncenter_max_retries: int = 4

    # deployed contract addresses (raw 0:hex or friendly), set per environment
    pool_core_address: str = ""
    adapter_address: str = ""
    stonfi_pool_address: str = ""
    stonfi_router_address: str = ""
    vault_address: str = ""
    draw_engine_address: str = ""
    jetton_master_address: str = ""  # jUSDT minter; used to derive owners' jetton wallets

    db_echo: bool = False
    db_pool_size: int = 5
    db_pooled: bool = False  # true if database_url points at a pgbouncer-style transaction pooler

    min_hold_epochs: int = 1  # epochs a deposit must age before it is draw-eligible
    skim_bps: int = 1000  # admin cut of the pot at settle (matches on-chain config)
    prize_tiers: int = 3
    deposit_cutoff: int = 600  # epoch_end = deposit_deadline + deposit_cutoff; matches deploy

    indexer_poll_interval: int = 10
    # refresh() costs a get-method per depositor plus five pool reads, so it runs on a
    # slower clock than the indexer; the tables it writes only move when a deposit lands
    derive_poll_interval: int = 60

    # keeper runtime
    operator_mnemonic: str = ""  # 24 words; empty -> dry-run (RecordingSender, no broadcast)
    keeper_poll_interval: int = 15
    keeper_dry_run: bool = False
    keeper_min_yield: int = 1  # dust floor below which a harvest tick is skipped

    @property
    def is_mainnet(self) -> bool:
        return self.env == "mainnet"


@lru_cache
def get_settings() -> Settings:
    return Settings()