import type { CpuMetrics } from "../../api/types";
import { Sparkline } from "../ui/Sparkline";
import { Panel } from "../ui/Panel";
import { ActivityIcon } from "../ui/icons";
import { MetricBar } from "../ui/MetricBar";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";

interface CpuPanelProps {
  cpu: CpuMetrics | null;
  sparkId: string;
  className?: string;
}

/**
 * CPU panel — shown for kind "mac" units (Apple Silicon Macs) where there is
 * no nvidia-smi GPU panel. Load-average-based usage + estimated power draw.
 */
export function CpuPanel({ cpu, sparkId, className }: CpuPanelProps) {
  const history = useMetricsHistoryTail(sparkId, "cpu.usage");
  const usage = cpu?.usage ?? 0;
  const draw = cpu?.draw ?? 0;

  return (
    <Panel
      title="CPU"
      icon={<ActivityIcon />}
      className={`panel-cpu ${className ?? ""}`}
      bodyClassName="space-y-3"
    >
      {cpu ? (
        <>
          <MetricBar
            label="Load"
            value={usage}
            max={100}
            caption={`${usage}% · est. ${draw}W`}
          />
          {history.length > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Usage</span>
              <div className="flex items-center gap-3">
                <Sparkline data={history} color="var(--color-accent)" width={180} />
                <span className="font-tabular text-sm font-semibold text-text">{usage}%</span>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="flex justify-between text-xs">
          <span className="text-muted">CPU</span>
          <span className="font-tabular text-text">—</span>
        </div>
      )}
    </Panel>
  );
}
