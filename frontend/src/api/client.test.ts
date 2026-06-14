import { ApiError, createApiClient } from "./client";

function mockFetch(status: number, body: unknown) {
  return vi.fn(
    async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      }) as Response,
  );
}

test("getHealth hits /health and parses the body", async () => {
  const f = mockFetch(200, { status: "ok", env: "testnet" });
  const api = createApiClient("http://api", f);
  const h = await api.getHealth();
  expect(h.env).toBe("testnet");
  expect(f).toHaveBeenCalledWith("http://api/health");
});

test("getPositions encodes the query string", async () => {
  const f = mockFetch(200, []);
  const api = createApiClient("http://api", f);
  await api.getPositions({ eligibleOnly: true, limit: 10 });
  expect(f).toHaveBeenCalledWith("http://api/positions?eligible_only=true&limit=10");
});

test("omitted query params are dropped", async () => {
  const f = mockFetch(200, []);
  const api = createApiClient("http://api", f);
  await api.getEvents();
  expect(f).toHaveBeenCalledWith("http://api/events");
});

test("getPool resolves to null on 404", async () => {
  const f = mockFetch(404, { detail: "no snapshot yet" });
  const api = createApiClient("http://api", f);
  expect(await api.getPool()).toBeNull();
});

test("a non-404 error throws ApiError with the status", async () => {
  const f = mockFetch(500, {});
  const api = createApiClient("http://api", f);
  await expect(api.getEpoch(1)).rejects.toMatchObject({
    constructor: ApiError,
    status: 500,
  });
});

test("getDraw fetches by epoch and parses payouts", async () => {
  const f = mockFetch(200, {
    epoch: 5,
    seed: null,
    distributable: 2250,
    skim: 250,
    num_winners: 1,
    settled_ts: null,
    payouts: [{ winner: "0:abc", amount: 2250, tier: 0, tx_hash: "0:tx", ts: 1 }],
  });
  const api = createApiClient("http://api", f);
  const d = await api.getDraw(5);
  expect(d.epoch).toBe(5);
  expect(d.payouts[0].winner).toBe("0:abc");
  expect(f).toHaveBeenCalledWith("http://api/draws/5");
});