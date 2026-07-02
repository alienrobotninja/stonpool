import asyncio
import contextlib
import logging
import signal
import sys
from collections.abc import Awaitable, Callable
from time import time

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.clients.chain import ChainClient, ToncenterClient
from app.clients.quote import harvest_plan
from app.clients.sources import build_quote_source, read_adapter_state, read_pool_data
from app.core.config import Settings, get_settings
from app.db.session import get_sessionmaker, init_engine
from app.keeper.executor import Keeper
from app.keeper.planner import KeeperState, Phase
from app.keeper.sender import RecordingSender, TxSender

log = logging.getLogger("stonpool.keeper")

# draw-engine get_phase(): 0 idle, 1 commit, 2 reveal, 3 awaiting finalize, 4 finalized
_DRAW_PHASE = {1: Phase.COMMIT, 2: Phase.REVEAL, 3: Phase.SETTLE}

StateProvider = Callable[[ChainClient, Settings, int], Awaitable[KeeperState | None]]


async def build_state(client: ChainClient, cfg: Settings, now: int) -> KeeperState | None:
    # Live-chain phase resolution. Runtime-only (depends on real get-method reads); the pure
    # phase mapping is unit-tested with a fake client, the end-to-end reads on testnet.
    pool = await read_pool_data(client, cfg.pool_core_address)
    adapter = await read_adapter_state(client, cfg.adapter_address)
    quote = await build_quote_source(client, cfg).fetch()
    base = dict(adapter=adapter, quote=quote, now=now, min_yield=cfg.keeper_min_yield)

    draw_phase = int((await client.run_get_method(cfg.draw_engine_address, "get_phase"))[0])
    if draw_phase in _DRAW_PHASE:
        draw = await client.run_get_method(cfg.draw_engine_address, "get_draw_state")
        draw_epoch = int(draw[0])
        pot = pool.prize_pot if draw_phase == 3 else 0
        return KeeperState(phase=_DRAW_PHASE[draw_phase], epoch=draw_epoch, prize_pot=pot, **base)

    # no draw open: roll the epoch once it has ended, otherwise sit idle while yield accrues
    if now >= pool.deposit_deadline + cfg.deposit_cutoff:
        hp = harvest_plan(adapter, quote)
        phase = Phase.HARVEST if hp.gross_yield >= cfg.keeper_min_yield else Phase.ADVANCE
        return KeeperState(phase=phase, epoch=pool.epoch, **base)
    return KeeperState(phase=Phase.ACCRUING, epoch=pool.epoch, **base)


_IDLE = (Phase.ACCRUING, Phase.SETTLED)


class KeeperRunner:
    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        client: ChainClient,
        sender: TxSender,
        cfg: Settings,
        interval: float,
        state_provider: StateProvider = build_state,
        clock: Callable[[], int] = lambda: int(time()),
    ):
        self.session_factory = session_factory
        self.client = client
        self.sender = sender
        self.cfg = cfg
        self.interval = interval
        self.state_provider = state_provider
        self.clock = clock

    async def run_once(self) -> list[str]:
        state = await self.state_provider(self.client, self.cfg, self.clock())
        if state is None or state.phase in _IDLE:
            log.info("idle: phase=%s", getattr(state, "phase", None))
            return []
        async with self.session_factory() as db:
            sent = await Keeper(self.client, self.sender, db, self.cfg).tick(state)
            await db.commit()
        log.info("tick: phase=%s epoch=%s sent=%d", state.phase, state.epoch, len(sent))
        return sent

    async def run_forever(self, stop: asyncio.Event) -> None:
        dry = isinstance(self.sender, RecordingSender)
        log.info("keeper up: interval=%ss dry_run=%s", self.interval, dry)
        while not stop.is_set():
            try:
                await self.run_once()
            except Exception:
                log.exception("tick failed")
            if stop.is_set():
                break
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=self.interval)
        log.info("keeper down")


def make_sender(cfg: Settings, client: ChainClient) -> TxSender:
    if cfg.keeper_dry_run or not cfg.operator_mnemonic:
        log.warning("dry-run: no broadcast (set STONPOOL_OPERATOR_MNEMONIC to go live)")
        return RecordingSender()
    from app.keeper.wallet_sender import WalletSender  # lazy: pulls pytoniq only when live

    return WalletSender(client, cfg.operator_mnemonic.split())


def build_runner(cfg: Settings | None = None) -> KeeperRunner:
    cfg = cfg or get_settings()
    init_engine(cfg)
    client = ToncenterClient(cfg)
    return KeeperRunner(
        session_factory=get_sessionmaker(),
        client=client,
        sender=make_sender(cfg, client),
        cfg=cfg,
        interval=cfg.keeper_poll_interval,
    )


async def _amain() -> None:
    runner = build_runner()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)
    await runner.run_forever(stop)


def check_config(cfg: Settings) -> list[str]:
    # non-broadcasting config validation for `python -m app.keeper --check`
    problems: list[str] = []
    required = (
        "pool_core_address",
        "adapter_address",
        "draw_engine_address",
        "jetton_master_address",
    )
    for name in required:
        if not getattr(cfg, name):
            problems.append(f"{name} is unset")
    if cfg.operator_mnemonic:
        words = len(cfg.operator_mnemonic.split())
        if words != 24:
            problems.append(f"operator_mnemonic has {words} words, expected 24")
    if cfg.keeper_poll_interval <= 0:
        problems.append("keeper_poll_interval must be positive")
    return problems


def _run_check(cfg: Settings) -> int:
    problems = check_config(cfg)
    if not problems:
        try:
            # builds the wallet (bad mnemonic / missing pytoniq surface here); no broadcast
            make_sender(cfg, ToncenterClient(cfg))
        except Exception as exc:
            problems.append(f"sender build failed: {exc}")
    for p in problems:
        log.error("config: %s", p)
    if not problems:
        live = not (cfg.keeper_dry_run or not cfg.operator_mnemonic)
        log.info("config ok (%s)", "live" if live else "dry-run")
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    args = sys.argv[1:] if argv is None else argv
    if "--check" in args:
        raise SystemExit(_run_check(get_settings()))
    asyncio.run(_amain())