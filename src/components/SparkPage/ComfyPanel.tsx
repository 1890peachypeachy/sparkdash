import type { ComfyJob, ComfyMetrics } from "../../api/types";
import { Panel } from "../ui/Panel";
import { ComfyIcon } from "../ui/icons";

interface ComfyPanelProps {
  comfy: ComfyMetrics | null;
  comfyPort: number;
  className?: string;
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…`;
}

function formatElapsed(createTimeMs: number | null | undefined): string | null {
  if (createTimeMs == null || !Number.isFinite(createTimeMs)) return null;
  // Comfy create_time is usually ms epoch; tolerate seconds.
  const ms = createTimeMs < 1e12 ? createTimeMs * 1000 : createTimeMs;
  const elapsedSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (elapsedSec < 60) return `${elapsedSec}s`;
  const m = Math.floor(elapsedSec / 60);
  const s = elapsedSec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function jobFootprint(job: ComfyJob): string {
  const parts: string[] = [];
  if (job.width != null && job.height != null) {
    parts.push(`${job.width}×${job.height}`);
  }
  if (job.steps != null) parts.push(`${job.steps} steps`);
  if (job.batchSize != null && job.batchSize !== 1) parts.push(`batch ${job.batchSize}`);
  if (job.sampler) parts.push(job.sampler);
  if (job.nodeCount > 0) parts.push(`${job.nodeCount} nodes`);
  return parts.join(" · ");
}

function JobBlock({
  job,
  variant,
}: {
  job: ComfyJob;
  variant: "running" | "pending";
}) {
  const title = job.title?.trim() || shortId(job.id);
  const footprint = jobFootprint(job);
  const elapsed = variant === "running" ? formatElapsed(job.createTime) : null;
  const models = job.models ?? [];

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-elevated/40 px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`llm-badge ${variant === "running" ? "" : "opacity-80"}`}
              title={job.id}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  variant === "running" ? "bg-accent" : "bg-muted"
                }`}
              />
              {variant === "running" ? "Running" : "Queued"}
            </span>
            {elapsed ? (
              <span className="font-tabular text-[11px] text-muted" title="Elapsed since queue entry">
                {elapsed}
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-sm font-medium text-text" title={job.title || job.id}>
            {title}
          </p>
        </div>
      </div>

      {footprint ? (
        <p className="font-tabular text-[11px] text-muted" title="Workflow compute footprint">
          {footprint}
        </p>
      ) : null}

      {models.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted">Models</div>
          <ul className="space-y-0.5">
            {models.slice(0, 6).map((m) => (
              <li
                key={m}
                className="truncate font-tabular text-[12px] text-text"
                title={m}
              >
                {m}
              </li>
            ))}
            {models.length > 6 ? (
              <li className="text-[11px] text-muted">+{models.length - 6} more</li>
            ) : null}
          </ul>
        </div>
      ) : (
        <p className="text-[11px] text-muted">No model files found in this graph.</p>
      )}
    </div>
  );
}

export function ComfyPanel({ comfy, comfyPort, className = "" }: ComfyPanelProps) {
  const available = Boolean(comfy?.available);
  const pending = comfy?.queuePending ?? 0;
  const active = comfy?.activeJob ?? null;
  const pendingJobs = comfy?.pendingJobs ?? [];

  return (
    <Panel
      title="ComfyUI"
      icon={<ComfyIcon />}
      className={`panel-comfy ${className}`}
      bodyClassName="space-y-3"
      accent
      actions={
        <span className="font-tabular text-[11px] text-muted" title="Probe port">
          :{comfyPort}
        </span>
      }
    >
      {!available ? (
        <div className="space-y-1 text-sm">
          <p className="text-muted">Not reachable</p>
          {comfy?.error ? (
            <p className="text-[11px] text-muted break-all">{comfy.error}</p>
          ) : (
            <p className="text-[11px] text-muted">
              Ensure ComfyUI is running on this host (default port 8188).
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="llm-badge">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Online
            </span>
            {comfy?.version ? (
              <span className="text-muted" title="ComfyUI version">
                v{comfy.version}
              </span>
            ) : null}
            {comfy?.deviceType ? (
              <span className="text-muted" title="ComfyUI compute device">
                {comfy.deviceType}
              </span>
            ) : null}
            {comfy?.pytorchVersion ? (
              <span className="text-muted" title="PyTorch version">
                torch {comfy.pytorchVersion}
              </span>
            ) : null}
          </div>

          {active ? (
            <JobBlock job={active} variant="running" />
          ) : (
            <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted">
              Idle — no running job
            </div>
          )}

          {pending > 0 ? (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-wide text-muted">
                <span>Queue</span>
                <span className="font-tabular normal-case text-muted">{pending} pending</span>
              </div>
              {pendingJobs.slice(0, 2).map((job) => (
                <JobBlock key={job.id} job={job} variant="pending" />
              ))}
              {pending > Math.min(2, pendingJobs.length) ? (
                <p className="text-[11px] text-muted">
                  +{pending - Math.min(2, pendingJobs.length)} more waiting
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}
