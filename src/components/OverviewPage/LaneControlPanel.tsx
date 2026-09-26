import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LaneInfo, LaneJob, LanePlan, LaneState } from "../../api/types";
import {
  batchLanes,
  cancelLaneJob,
  checkLanes,
  laneJob as fetchLaneJob,
  laneVerify,
  listLanes,
} from "../../api/client";
import { Panel } from "../ui/Panel";
import { PowerOffIcon, PowerOnIcon, RotateIcon } from "../ui/icons";

/**
 * Fleet lane control (Phase 2: manual switches, no rotation).
 *
 * Victor's model, verbatim: "I don't want rotation. I want to be able to pull
 * down and put up whatever I want." So there is no prescribed sequence and no
 * auto-parking here. The panel proposes nothing; it only executes the lanes you
 * tick, and the SERVER enforces the gate:
 *
 *   two lanes can be up together iff their node sets are disjoint
 *   (tp3 {1,3,4} + creative {2} is fine; tp4 {1,2,3,4} blocks everything).
 *
 * Blockers are reported, never auto-resolved. If tp3 is blocked by tp4 you pull
 * tp4 down yourself — or tick both and use the combined swap button.
 *
 * A lane serving on :8000 is PRODUCTION: taking it down asks you to type its name.
 */

const STATE_STYLE: Record<LaneState, { label: string; dot: string; text: string }> = {
  up: { label: "SERVING", dot: "bg-success", text: "text-success" },
  partial: { label: "PARTIAL", dot: "bg-warning", text: "text-warning" },
  down: { label: "down", dot: "bg-muted/50", text: "text-muted" },
};

const isProduction = (lane: LaneInfo) => lane.endpoint.includes(":8000");
const JOB_POLL_MS = 1500;
const LOG_TAIL = 14;

interface Dialog {
  kind: "down" | "swap";
  down: string[];
  up: string[];
  /** EVERY production (:8000) lane being torn down — all names must be typed */
  typeNames: string[];
}

export function LaneControlPanel() {
  const [lanes, setLanes] = useState<LaneInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<LanePlan | null>(null);
  const [job, setJob] = useState<LaneJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [typed, setTyped] = useState("");

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
    // The server caches the harness call ~20s, so a 20s poll stays on cache.
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  const byId = useMemo(() => new Map((lanes ?? []).map((l) => [l.id, l])), [lanes]);
  const upSel = useMemo(
    () => [...selected].filter((id) => byId.get(id)?.status !== "up"),
    [selected, byId],
  );
  const downSel = useMemo(
    () => [...selected].filter((id) => byId.get(id)?.status === "up"),
    [selected, byId],
  );

  // Live gate preview. It dry-runs the INTENDED action, which depends on the
// selection: with nothing ticked for teardown it is "bring these up"; with a lane
// also ticked for teardown it is the swap (down frees the nodes first).
  const planKey = `${upSel.join(",")}|${downSel.join(",")}`;
  useEffect(() => {
    if (!upSel.length) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    void checkLanes(upSel, downSel).then(
      (p) => !cancelled && setPlan(p),
      () => !cancelled && setPlan(null),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);

  const clearSelection = () => setSelected(new Set());

  /** Poll a started job until it leaves "running", then refresh the lane view. */
  const watch = useCallback(
    async (jobId: string) => {
      for (;;) {
        let j: LaneJob;
        try {
          j = await fetchLaneJob(jobId);
        } catch {
          break;
        }
        setJob(j);
        if (j.status !== "running") break;
        await new Promise((r) => setTimeout(r, JOB_POLL_MS));
      }
      // One forced refresh after the job settles — `load(true)` re-sweeps the fleet
      // (~7s over SSH), so doing it inside the loop as well was a wasted sweep.
      await load(true);
      setBusy(false);
    },
    [load],
  );

  const run = useCallback(
    async (fn: () => Promise<{ jobId: string; job: LaneJob }>) => {
      setBusy(true);
      setError(null);
      setDialog(null);
      setTyped("");
      try {
        const { jobId } = await fn();
        await watch(jobId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    },
    [watch],
  );

  const onToggle = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const blockedText = (plan?.blocked ?? []).map((b) =>
    b.reason === "node-held"
      ? `${b.lane} needs ${b.node}, held by ${b.holder}`
      : `${(b.lanes ?? []).join(" + ")} share ${(b.nodes ?? []).join(",")}`,
  );

  /** Production (:8000) lanes within a teardown set — each needs its name typed. */
  const prodLanesIn = (ids: string[]) =>
    ids.filter((id) => {
      const l = byId.get(id);
      return l ? isProduction(l) : false;
    });

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
        <p className="mb-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-text">
          {error}
        </p>
      )}
      {!lanes && !error && <p className="text-xs text-muted">Reading lanes…</p>}

      {lanes && (
        <div className="flex flex-col">
          {lanes.map((lane) => (
            <LaneRow
              key={lane.id}
              lane={lane}
              checked={selected.has(lane.id)}
              onToggle={(c) => onToggle(lane.id, c)}
              disabled={busy}
              onVerify={() => void run(() => laneVerify(lane.id))}
            />
          ))}
        </div>
      )}

      {/* Gate preview + actions */}
      {lanes && (
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
          {upSel.length > 0 && plan && (
            <p
              className={`text-[11px] ${plan.launchable ? "text-success" : "text-warning"}`}
              title={blockedText.join("\n")}
            >
              {plan.launchable
                ? `✓ ${upSel.join(", ")} can be brought up together`
                : `✗ blocked: ${blockedText.join("; ")}`}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || !upSel.length || !plan?.launchable || downSel.length > 0}
              onClick={() => void run(() => batchLanes(upSel, []))}
              className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1 text-[11px] transition-colors hover:bg-surface-hover disabled:opacity-40"
            >
              <PowerOnIcon className="h-3 w-3" />
              Put up selected{upSel.length ? ` (${upSel.length})` : ""}
            </button>
            <button
              type="button"
              disabled={busy || !downSel.length}
              onClick={() => {
                setTyped("");
                setDialog({ kind: "down", down: downSel, up: [], typeNames: prodLanesIn(downSel) });
              }}
              className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1 text-[11px] transition-colors hover:bg-surface-hover disabled:opacity-40"
            >
              <PowerOffIcon className="h-3 w-3" />
              Pull down selected{downSel.length ? ` (${downSel.length})` : ""}
            </button>
            {downSel.length > 0 && upSel.length > 0 && (
              <button
                type="button"
                disabled={busy || !plan?.launchable}
                onClick={() => {
                  setTyped("");
                  setDialog({ kind: "swap", down: downSel, up: upSel, typeNames: prodLanesIn(downSel) });
                }}
                className="flex items-center gap-1 rounded-md border border-accent/50 bg-accent/10 px-2.5 py-1 text-[11px] transition-colors hover:bg-accent/20 disabled:opacity-40"
              >
                Swap: down {downSel.length} → up {upSel.length}
              </button>
            )}
            {selected.size > 0 && (
              <button
                type="button"
                onClick={clearSelection}
                className="text-[11px] text-muted underline-offset-2 hover:text-text hover:underline"
              >
                clear
              </button>
            )}
            {!selected.size && (
              <span className="text-[11px] text-muted">
                Tick lanes to control them, then choose an action.
              </span>
            )}
          </div>
        </div>
      )}

      {/* Confirm dialog */}
      {dialog && (
        <ConfirmDialog
          dialog={dialog}
          typed={typed}
          onTyped={setTyped}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const { kind, down, up } = dialog;
            void run(() =>
              kind === "swap"
                ? batchLanes(up, down, true)
                : batchLanes([], down, true),
            );
          }}
        />
      )}

      {/* Live job */}
      {job && <JobView job={job} onCancel={() => void cancelLaneJob(job.jobId)} />}
    </Panel>
  );
}

function LaneRow({
  lane,
  checked,
  onToggle,
  disabled,
  onVerify,
}: {
  lane: LaneInfo;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  disabled: boolean;
  onVerify: () => void;
}) {
  const s = STATE_STYLE[lane.status] ?? STATE_STYLE.down;
  const holders = Object.entries(lane.holders ?? {});
  const blockers = Array.from(new Set(holders.map(([, l]) => l)));
  const prod = isProduction(lane);

  return (
    <div className="flex flex-col gap-1 border-t border-border px-1 py-2 first:border-t-0">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onToggle(e.target.checked)}
          aria-label={`select ${lane.id}`}
          className="h-3.5 w-3.5 shrink-0 accent-accent"
        />
        <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
        <span className="font-tabular text-[13px] font-semibold text-text">{lane.id}</span>
        {prod && (
          <span className="rounded border border-warning/50 bg-warning/10 px-1 text-[10px] text-warning">
            PROD
          </span>
        )}
        <span className="text-[11px] text-muted">{lane.nodes.join(", ")}</span>
        <span className={`ml-auto font-tabular text-[11px] font-medium ${s.text}`}>{s.label}</span>
        <button
          type="button"
          onClick={onVerify}
          disabled={disabled}
          title="Read-only health check: endpoint + real chat canary. Changes nothing."
          className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-40"
        >
          verify
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-6 text-[11px] text-muted">
        <span className="font-tabular">{lane.endpoint}</span>
        <span className="truncate" title={lane.model}>
          {lane.model}
        </span>
      </div>
      {lane.status !== "up" && blockers.length > 0 && (
        <div className="pl-6 text-[11px] text-warning">
          blocked by {blockers.join(", ")} — {holders.map(([n, l]) => `${n}:${l}`).join(" ")}
        </div>
      )}
    </div>
  );
}

function ConfirmDialog({
  dialog,
  typed,
  onTyped,
  onCancel,
  onConfirm,
}: {
  dialog: Dialog;
  typed: string;
  onTyped: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const required = dialog.typeNames;
  // Every production lane in the teardown set must be named — typing one must not
  // unlock tearing down another. Tokens are whitespace/comma separated so several
  // can be typed into the one field.
  const tokens = typed.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const ready = required.every((n) => tokens.includes(n.toLowerCase()));
  const isSwap = dialog.up.length > 0;

  return (
    <div className="mt-3 rounded-md border border-warning/50 bg-warning/10 p-3">
      <p className="text-[12px] font-semibold text-text">
        Take down {dialog.down.join(", ")}
        {dialog.up.length ? ` and bring up ${dialog.up.join(", ")}` : ""}?
      </p>
      <p className="mt-1 text-[11px] text-muted">
        This stops the model serving on those nodes. Lanes come back up only when you
        ask — nothing rotates on its own.
      </p>
      {isSwap && (
        <p className="mt-1 rounded border border-warning/40 px-2 py-1 text-[11px] text-warning">
          Swap runs in order: {dialog.down.join(", ")} goes down first, then{" "}
          {dialog.up.join(", ")} comes up. Cancelling after the teardown finishes leaves those
          nodes <strong>not serving</strong> — bring a lane back up before you walk away.
        </p>
      )}
      {required.length > 0 && (
        <label className="mt-2 block text-[11px] text-warning">
          <span className="font-semibold">
            {required.join(", ")} {required.length > 1 ? "are" : "is"} production (:8000).
          </span>{" "}
          Type {required.length > 1 ? "each lane name (space-separated)" : "the lane name"} to
          confirm:
          <input
            value={typed}
            onChange={(e) => onTyped(e.target.value)}
            placeholder={required.join(" ")}
            className="mt-1 w-full rounded border border-border bg-surface px-2 py-1 font-tabular text-[12px] text-text"
          />
        </label>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={!ready}
          onClick={onConfirm}
          className="rounded-md border border-danger/60 bg-danger/15 px-2.5 py-1 text-[11px] font-medium text-text transition-colors hover:bg-danger/25 disabled:opacity-40"
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-text"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function JobView({ job, onCancel }: { job: LaneJob; onCancel: () => void }) {
  const logRef = useRef<HTMLPreElement>(null);
  const lines = job.progress.log ?? [];

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines.length]);

  const tone =
    job.status === "running"
      ? "text-warning"
      : job.status === "completed"
        ? "text-success"
        : "text-danger";

  return (
    <div className="mt-3 rounded-md border border-border bg-surface-elevated p-2.5">
      <div className="flex items-center gap-2">
        <span className={`text-[11px] font-semibold ${tone}`}>{job.status.toUpperCase()}</span>
        <span className="font-tabular text-[11px] text-muted">
          {job.verb === "batch"
            ? `down ${job.down.join(",") || "—"} → up ${job.up.join(",") || "—"}`
            : `${job.verb} ${job.lane}`}
        </span>
        {job.status === "running" && (
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto rounded border border-border px-2 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            Cancel
          </button>
        )}
      </div>
      {job.progress.step && (
        <p className="mt-1 font-tabular text-[11px] text-text">{job.progress.step}</p>
      )}
      {job.steps.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px]">
          {job.steps.map((s, i) => (
            <span key={i} className={s.ok ? "text-success" : "text-danger"}>
              {s.ok ? "✓" : "✗"} {s.verb} {s.lane}
            </span>
          ))}
        </div>
      )}
      {lines.length > 0 && (
        <pre
          ref={logRef}
          className="mt-1.5 max-h-40 overflow-y-auto rounded bg-surface p-2 font-mono text-[10px] leading-relaxed text-muted"
        >
          {lines.slice(-LOG_TAIL).join("\n")}
        </pre>
      )}
    </div>
  );
}