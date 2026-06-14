import { api } from "../api/client";

import { usePoll } from "./usePoll";

export const usePool = (intervalMs?: number) => usePoll(() => api.getPool(), intervalMs);
export const usePositions = (intervalMs?: number) => usePoll(() => api.getPositions(), intervalMs);
export const useEvents = (limit = 30, intervalMs?: number) =>
  usePoll(() => api.getEvents(limit), intervalMs);
export const useDraws = (limit = 10, intervalMs?: number) =>
  usePoll(() => api.getDraws(limit), intervalMs);