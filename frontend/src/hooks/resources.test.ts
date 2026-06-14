import { renderHook, waitFor } from "@testing-library/react";

import { api } from "../api/client";
import { useDraws, useEvents, usePool, usePositions } from "./resources";

vi.mock("../api/client", () => ({
  api: {
    getPool: vi.fn(),
    getPositions: vi.fn(),
    getEvents: vi.fn(),
    getDraws: vi.fn(),
  },
}));

beforeEach(() => vi.clearAllMocks());

test("usePool calls getPool", async () => {
  vi.mocked(api.getPool).mockResolvedValue(null);
  renderHook(() => usePool(100000));
  await waitFor(() => expect(api.getPool).toHaveBeenCalled());
});

test("usePositions calls getPositions", async () => {
  vi.mocked(api.getPositions).mockResolvedValue([]);
  renderHook(() => usePositions(100000));
  await waitFor(() => expect(api.getPositions).toHaveBeenCalled());
});

test("useEvents passes the limit", async () => {
  vi.mocked(api.getEvents).mockResolvedValue([]);
  renderHook(() => useEvents(5, 100000));
  await waitFor(() => expect(api.getEvents).toHaveBeenCalledWith(5));
});

test("useDraws passes the limit", async () => {
  vi.mocked(api.getDraws).mockResolvedValue([]);
  renderHook(() => useDraws(3, 100000));
  await waitFor(() => expect(api.getDraws).toHaveBeenCalledWith(3));
});