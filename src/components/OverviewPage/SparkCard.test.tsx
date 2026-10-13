import { act } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  fetchLaunchers: () => new Promise(() => {}),
  runLauncher: vi.fn(),
  wakeSpark: vi.fn(),
}));

import { SparkCard } from "./SparkCard";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import type { SparkSnapshot } from "../../api/types";

function worker(): SparkSnapshot {
  return { ...makeSpark("w"), role: "worker", workerNode: true, workerHeadId: "h", workerLabel: "cfg-label" } as SparkSnapshot;
}
function head(online: boolean): SparkSnapshot {
  const h = makeSpark("h", online);
  return {
    ...h,
    role: "head",
    metrics: { ...h.metrics, llm: [{ available: true, backend: "vllm", modelId: "big-model", generationTps: 12, prefillTps: 100, contextLength: 4096 }] },
  } as unknown as SparkSnapshot;
}

describe("SparkCard", () => {
  it("is a plain container whose name is the only link; no interactive element nests another", () => {
    const onSelect = vi.fn();
    const { container } = render(<SparkCard spark={makeSpark("a")} temperatureUnit="celsius" onSelect={onSelect} />);
    const card = container.querySelector(".ov-sc")!;
    expect(card.getAttribute("role")).toBeNull();
    expect(card.getAttribute("tabindex")).toBeNull();
    const link = card.querySelector<HTMLAnchorElement>("a.ov-sc__link")!;
    expect(link.textContent).toBe("Spark a");
    for (const el of card.querySelectorAll("button, a, [role=button]")) {
      expect(el.querySelector("button, a, [role=button]")).toBeNull();
    }
    act(() => link.click());
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("does not select when clicking the card body (only the stretched name does)", () => {
    const onSelect = vi.fn();
    const { container } = render(<SparkCard spark={makeSpark("a")} temperatureUnit="celsius" onSelect={onSelect} />);
    act(() => container.querySelector<HTMLElement>(".ov-sc__body")?.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a worker shows its online head's model", () => {
    const { container } = render(<SparkCard spark={worker()} headSpark={head(true)} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("big-model");
  });

function macSpark(): SparkSnapshot {
  const m = makeSpark("mac", true);
  return {
    ...m,
    kind: "mac",
    metrics: {
      ...m.metrics,
      // macs report a zeroed gpu shell (no nvidia-smi) but real cpu/ram
      gpu: { usage: 0, temperature: 0, vram: { used: 0, total: 0, available: 0, percentage: 0 }, power: { draw: 0, limit: 120 } },
      cpu: { usage: 27, temperature: 0 },
      ram: { used: 11305, total: 16384, available: 5079, percentage: 69 },
    },
  } as unknown as SparkSnapshot;
}

  it("a mac card shows CPU and RAM and hides the zeroed GPU temp/power rows", () => {
    const { container } = render(<SparkCard spark={macSpark()} temperatureUnit="celsius" />);
    const text = container.textContent ?? "";
    expect(text).toContain("CPU");
    expect(text).toContain("27%");
    expect(text).toContain("RAM");
    expect(text).toContain("11 / 16 GB");
    expect(text).not.toContain("GPU temp");
    expect(text).not.toContain("GPU power");
  });

  it("a worker does not show an offline head's stale model", () => {
    const { container } = render(<SparkCard spark={worker()} headSpark={head(false)} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("big-model");
    expect(container.textContent).toContain("cfg-label");
    expect(container.textContent).toContain("Head is offline");
  });
});
