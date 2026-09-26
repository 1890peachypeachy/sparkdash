import { useCallback, useEffect, useState } from "react";
import type { LaneInfo, LaneState } from "../../api/types";
import { listLanes } from "../../api/client";
import { Panel } from "../ui/Panel";
import { RotateIcon } from "../ui/icons";

/** Fleet-level lane control panel (Phase 1: read-only inventory).
 *
 * A front end over the spark-lane harness — this panel never decides what is safe
 * to run, it reports what the harness reports. Up/down switches (gated by
 * node-disjointness) land in Phase 2.
 */

const STATE_STYLE: Record<LaneState, { label: string; dot: string; text: string }> = {
  up: { label: "SERVING", dot: "bg-success", text: "text-success" },
  partial: { label: "PARTIAL", dot: "bg-warning", text: "text-warning" },
  down: { label: "down", dot: "bg-muted/50", text: "text-muted" },
};

function LaneRow({ lane }: { lane: LaneInfo }) {
  const s = STATE_STYLE[lane.status] ?? STATE_STYLE.down;
  const holders = Object.entries(lane.holders ?? {});
  // For a down lane, the holders are the other lane(s) blocking it.
  const blockerLanes = Array.from(new Set(holders.map(([, l]) => l)));

  return (
    <div className="flex flex-col gap-1 border-t border-border px-1 py-2 first:border-t-0">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
        <span className="font-tabular text-[13px] font-semibold text-text">{lane.id}</span>
        <span className="text-[11px] text-muted">{lane.nodes.join(", ")}</span>
        <span className={`ml-auto font-tabular text-[11px] font-medium ${s.text}`}>{s.label}</span>
      </div>
      <div className="pl-4 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
        <span className="font-tabular">{lane.endpoint}</span>
        <span className="truncate" title={lane.model}>
          {lane.model}
        </span>
      </div>
      {lane.status !== "up" && blockerLanes.length > 0 && (
        <div className="pl-4 text-[11px] text-warning">
          blocked by {blockerLanes.join(", ")} — {holders.map(([n, l]) => `${n}:${l}`).join(" ")}
        </div>
      )}
    </div>
  );
}

export function LaneControlPanel() {
  const [lanes, setLanes] = useState<LaneInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const { lanes: l } = await listLanes(force);
      setLanes(l);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (force) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // The server caches the harness call for ~20s, so a 20s poll stays on cache.
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const anyUp = (lanes ?? []).some((l) => l.status === "up");

  return (
    <Panel
      title="Lane Control"
      icon={<RotateIcon />}
      accent={Boolean(error)}
      actions={
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing}
          title="Re-read the lane inventory from the fleet"
          className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1 text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
        >
          <RotateIcon className="h-3 w-3" />
          Refresh
        </button>
      }
    >
      {error && (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-text">
          {error}
        </p>
      )}
      {!lanes && !error && <p className="text-xs text-muted">Reading lanes…</p>}
      {lanes && (
        <div className="flex flex-col">
          {lanes.map((l) => (
            <LaneRow key={l.id} lane={l} />
          ))}
          {!anyUp && (
            <p className="mt-1 text-[11px] text-muted">No lane serving right now.</p>
          )}
        </div>
      )}
    </Panel>
  );
}