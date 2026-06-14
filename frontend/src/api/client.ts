import { config } from "../config";

import type {
  ActivityEvent,
  Draw,
  Epoch,
  Health,
  Position,
  Snapshot,
  WalletBalance,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type FetchFn = typeof fetch;
type QueryValue = string | number | boolean | undefined;

function qs(params: Record<string, QueryValue>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export interface ApiClient {
  getHealth(): Promise<Health>;
  getPool(): Promise<Snapshot | null>;
  getSnapshots(limit?: number): Promise<Snapshot[]>;
  getEpochs(limit?: number): Promise<Epoch[]>;
  getEpoch(epoch: number): Promise<Epoch>;
  getPositions(opts?: { eligibleOnly?: boolean; limit?: number }): Promise<Position[]>;
  getPosition(address: string): Promise<Position>;
  getEvents(limit?: number): Promise<ActivityEvent[]>;
  getDraws(limit?: number): Promise<Draw[]>;
  getDraw(epoch: number): Promise<Draw>;
  getWalletBalance(address: string): Promise<WalletBalance>;
}

export function createApiClient(baseUrl = config.apiBaseUrl, fetchFn: FetchFn = fetch): ApiClient {
  async function request<T>(path: string): Promise<T> {
    const res = await fetchFn(`${baseUrl}${path}`);
    if (!res.ok) {
      throw new ApiError(res.status, `GET ${path} failed with ${res.status}`);
    }
    return (await res.json()) as T;
  }

  return {
    getHealth: () => request<Health>("/health"),
    getPool: async () => {
      try {
        return await request<Snapshot>("/pool");
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    getSnapshots: (limit) => request<Snapshot[]>(`/snapshots${qs({ limit })}`),
    getEpochs: (limit) => request<Epoch[]>(`/epochs${qs({ limit })}`),
    getEpoch: (epoch) => request<Epoch>(`/epochs/${epoch}`),
    getPositions: (opts) =>
      request<Position[]>(
        `/positions${qs({ eligible_only: opts?.eligibleOnly, limit: opts?.limit })}`,
      ),
    getPosition: (address) => request<Position>(`/positions/${address}`),
    getEvents: (limit) => request<ActivityEvent[]>(`/events${qs({ limit })}`),
    getDraws: (limit) => request<Draw[]>(`/draws${qs({ limit })}`),
    getDraw: (epoch) => request<Draw>(`/draws/${epoch}`),
    getWalletBalance: (address) => request<WalletBalance>(`/wallet/${address}`),
  };
}

export const api = createApiClient();