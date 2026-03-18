import { useState, useEffect, useRef, useCallback } from "react";
import type { DaemonClient, TraversalSummary, TraversalDetail } from "../client.js";

export interface PollingConfig {
  activeInterval: number;   // ms, default 2000
  waitingInterval: number;  // ms, default 5000
}

const DEFAULT_POLLING: PollingConfig = {
  activeInterval: 2000,
  waitingInterval: 5000,
};

export interface PollingState {
  traversals: TraversalSummary[];
  selectedDetail: TraversalDetail | null;
  error: string | null;
  loading: boolean;
}

export function usePolling(
  client: DaemonClient,
  selectedId: string | null,
  config: Partial<PollingConfig> = {}
): PollingState {
  const intervals = { ...DEFAULT_POLLING, ...config };
  const [traversals, setTraversals] = useState<TraversalSummary[]>([]);
  const [selectedDetail, setSelectedDetail] = useState<TraversalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const prevTraversalsRef = useRef<string>("");

  const fetchTraversals = useCallback(async () => {
    try {
      const list = await client.listTraversals();
      const serialized = JSON.stringify(list);
      // Only update state if data actually changed
      if (serialized !== prevTraversalsRef.current) {
        prevTraversalsRef.current = serialized;
        setTraversals(list);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  const fetchDetail = useCallback(async () => {
    if (!selectedId) {
      setSelectedDetail(null);
      return;
    }
    try {
      const detail = await client.inspectTraversal(selectedId, "position");
      setSelectedDetail(detail);
    } catch {
      setSelectedDetail(null);
    }
  }, [client, selectedId]);

  // Initial fetch
  useEffect(() => {
    fetchTraversals();
    fetchDetail();
  }, [fetchTraversals, fetchDetail]);

  // Polling loop — uses the fastest needed interval
  useEffect(() => {
    // All listed traversals are active (daemon only tracks active ones)
    const interval = traversals.length > 0 ? intervals.activeInterval : intervals.waitingInterval;

    const timer = setInterval(() => {
      fetchTraversals();
      if (selectedId) fetchDetail();
    }, interval);

    return () => clearInterval(timer);
  }, [traversals, selectedId, intervals.activeInterval, intervals.waitingInterval, fetchTraversals, fetchDetail]);

  return { traversals, selectedDetail, error, loading };
}
