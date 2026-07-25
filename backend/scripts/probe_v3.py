import argparse
import asyncio
import base64
import json
from collections import Counter
from pathlib import Path

import certifi
import httpx
from pytoniq_core import Cell

from app.core.config import get_settings


def opcode(body_b64):
    try:
        s = Cell.one_from_boc(base64.b64decode(body_b64)).begin_parse()
    except Exception as e:
        return f"unparsable: {e}"
    if s.remaining_bits < 32:
        return "no-op"
    return hex(s.load_uint(32))


async def get(cfg, params):
    headers = {"X-API-Key": cfg.toncenter_api_key} if cfg.toncenter_api_key else {}
    # pinned to certifi: httpx hands a stale SSL_CERT_FILE straight to the ssl module and
    # dies on a missing path before it ever opens a socket
    async with httpx.AsyncClient(
        base_url=cfg.toncenter_base_url, timeout=30.0, verify=certifi.where()
    ) as c:
        r = await c.get("/transactions", params=params, headers=headers)
    print(f"GET {r.request.url} -> {r.status_code}")
    if r.status_code != 200:
        print("  " + r.text[:400])
        return None
    return r.json()


def report(payload):
    txs = payload.get("transactions", [])
    print(f"  envelope keys: {', '.join(sorted(payload))}")
    print(f"  transactions: {len(txs)}")
    if not txs:
        return
    print(f"  tx keys: {', '.join(sorted({k for t in txs for k in t}))}")
    print(f"  in_msg keys: {', '.join(sorted({k for t in txs for k in t.get('in_msg') or {}}))}")

    have_in, have_src, have_body = 0, 0, 0
    ops = Counter()
    for t in txs:
        m = t.get("in_msg") or {}
        have_in += bool(m)
        have_src += bool(m.get("source"))
        body = (m.get("message_content") or {}).get("body")
        if body:
            have_body += 1
            ops[opcode(body)] += 1
    print(f"  with in_msg {have_in}, with source {have_src}, with body {have_body}")
    for op, n in ops.most_common():
        print(f"    {op}: {n}")
    print(f"  notifications (0x7362d09c): {ops.get('0x7362d09c', 0)}")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--account", help="raw 0:hex; defaults to the configured pool-core")
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--start-lt", type=int, default=0)
    ap.add_argument("--out", default="tests/fixtures/v3_transactions_poolcore.json")
    args = ap.parse_args()

    cfg = get_settings()
    account = args.account or cfg.pool_core_address
    if not account:
        raise SystemExit("no account: pass --account or set STONPOOL_POOL_CORE_ADDRESS")
    print(f"base {cfg.toncenter_base_url}  key {'set' if cfg.toncenter_api_key else 'MISSING'}")

    # same params ToncenterClient.get_transactions builds, so a shape the probe sees is a
    # shape production sees. the bare retry below separates a rejected param from an
    # account with nothing to return.
    params = {"account": account, "limit": args.limit, "sort": "asc"}
    if args.start_lt:
        params["start_lt"] = args.start_lt + 1
    payload = await get(cfg, params)
    if payload is not None:
        report(payload)
    if payload is None or not payload.get("transactions"):
        print("retrying without sort/start_lt")
        payload = await get(cfg, {"account": account, "limit": args.limit})
        if payload is not None:
            report(payload)

    if payload:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, indent=2))
        print(f"wrote {out}")


if __name__ == "__main__":
    asyncio.run(main())