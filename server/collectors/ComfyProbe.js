/**
 * ComfyProbe — polls a local ComfyUI HTTP server (default port 8188).
 *
 * Focus: what is running (job / workflow footprint), not host RAM/VRAM
 * (those already live on GPU / CPU panels).
 *
 * Endpoints (stock ComfyUI):
 *   GET /system_stats — reachability + version
 *   GET /queue        — running / pending items with full prompt graph
 */
import { COMFY_PROBE_TIMEOUT_MS, COMFY_PORT } from "../config.js";
import { llmProbeHost } from "./llmHost.js";

/**
 * @param {unknown} n
 * @returns {number | null}
 */
function numOrNull(n) {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** @param {string} path */
function basename(path) {
  const s = String(path);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

const MODEL_FILE_RE = /\.(safetensors|sft|ckpt|pt|bin|gguf|pth|onnx)$/i;

/**
 * Summarize a ComfyUI prompt graph into human-facing workload fields.
 * @param {unknown} prompt
 */
export function summarizeComfyPrompt(prompt) {
  /** @type {string[]} */
  const models = [];
  let nodeCount = 0;
  /** @type {number | null} */
  let steps = null;
  /** @type {number | null} */
  let width = null;
  /** @type {number | null} */
  let height = null;
  /** @type {number | null} */
  let batchSize = null;
  /** @type {string | null} */
  let sampler = null;
  /** @type {Record<string, number>} */
  const classCounts = {};

  if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) {
    return {
      models: [],
      nodeCount: 0,
      steps: null,
      width: null,
      height: null,
      batchSize: null,
      sampler: null,
      classCounts: {},
    };
  }

  for (const node of Object.values(prompt)) {
    if (!node || typeof node !== "object") continue;
    nodeCount += 1;
    const ct =
      /** @type {{ class_type?: unknown, inputs?: unknown }} */ (node).class_type != null
        ? String(/** @type {{ class_type?: unknown }} */ (node).class_type)
        : "Unknown";
    classCounts[ct] = (classCounts[ct] || 0) + 1;
    const inputs = /** @type {{ inputs?: Record<string, unknown> }} */ (node).inputs;
    if (!inputs || typeof inputs !== "object") continue;

    for (const [key, val] of Object.entries(inputs)) {
      if (typeof val === "string" && MODEL_FILE_RE.test(val)) {
        models.push(basename(val));
        continue;
      }
      if (key === "steps" && steps == null) {
        const n = numOrNull(val);
        if (n != null) steps = n;
      } else if (key === "width" && width == null) {
        const n = numOrNull(val);
        if (n != null) width = n;
      } else if (key === "height" && height == null) {
        const n = numOrNull(val);
        if (n != null) height = n;
      } else if (key === "batch_size" && batchSize == null) {
        const n = numOrNull(val);
        if (n != null) batchSize = n;
      } else if (key === "sampler_name" && sampler == null && typeof val === "string") {
        sampler = val;
      }
    }
  }

  // Dedupe models, preserve order
  const seen = new Set();
  const uniqueModels = [];
  for (const m of models) {
    if (seen.has(m)) continue;
    seen.add(m);
    uniqueModels.push(m);
  }

  return {
    models: uniqueModels,
    nodeCount,
    steps,
    width,
    height,
    batchSize,
    sampler,
    classCounts,
  };
}

/**
 * @param {unknown} item queue tuple from /queue
 * @param {"running" | "pending"} status
 */
function normalizeQueueJob(item, status) {
  if (!Array.isArray(item) || item.length < 3) return null;
  const promptId = item[1] != null ? String(item[1]) : null;
  if (!promptId) return null;
  const prompt = item[2];
  const extra = item[3] && typeof item[3] === "object" ? item[3] : {};
  const summary = summarizeComfyPrompt(prompt);

  /** @type {string | null} */
  let title = null;
  try {
    const png = /** @type {{ extra_pnginfo?: { workflow?: { title?: unknown, name?: unknown } } }} */ (
      extra
    ).extra_pnginfo;
    const wf = png?.workflow;
    if (wf?.title != null && String(wf.title).trim()) title = String(wf.title).trim();
    else if (wf?.name != null && String(wf.name).trim()) title = String(wf.name).trim();
  } catch {
    /* ignore */
  }
  if (!title && typeof extra.client_id === "string" && extra.client_id) {
    // weak fallback — usually not useful; leave null
  }

  const createTime = numOrNull(extra.create_time);

  return {
    id: promptId,
    status,
    title,
    models: summary.models,
    nodeCount: summary.nodeCount,
    steps: summary.steps,
    width: summary.width,
    height: summary.height,
    batchSize: summary.batchSize,
    sampler: summary.sampler,
    createTime,
  };
}

export class ComfyProbe {
  /**
   * @param {object} spark
   * @param {number} [port]
   */
  constructor(spark, port = COMFY_PORT) {
    this.spark = spark;
    this.port = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : COMFY_PORT;
    this.baseUrl = `http://${llmProbeHost(spark)}:${this.port}`;
    this.error = null;
  }

  /** Update port / host from current spark config. */
  setTarget(spark, port) {
    this.spark = spark ?? this.spark;
    const next = Number(port);
    if (Number.isInteger(next) && next >= 1 && next <= 65535) {
      this.port = next;
    }
    this.baseUrl = `http://${llmProbeHost(this.spark)}:${this.port}`;
  }

  /**
   * Probe ComfyUI and return a snapshot for the Spark metrics payload.
   * @returns {Promise<object>}
   */
  async probe() {
    try {
      const signal = AbortSignal.timeout(COMFY_PROBE_TIMEOUT_MS);
      const [statsRes, queueRes] = await Promise.all([
        fetch(`${this.baseUrl}/system_stats`, { signal }),
        fetch(`${this.baseUrl}/queue`, { signal }),
      ]);

      if (!statsRes.ok) {
        this.error = `HTTP ${statsRes.status} on /system_stats`;
        return this._default();
      }

      const stats = await statsRes.json().catch(() => null);
      if (!stats || typeof stats !== "object") {
        this.error = "Invalid /system_stats response";
        return this._default();
      }

      /** @type {object[]} */
      let runningJobs = [];
      /** @type {object[]} */
      let pendingJobs = [];
      if (queueRes.ok) {
        const queue = await queueRes.json().catch(() => null);
        if (queue && typeof queue === "object") {
          const runningRaw = Array.isArray(queue.queue_running) ? queue.queue_running : [];
          const pendingRaw = Array.isArray(queue.queue_pending) ? queue.queue_pending : [];
          runningJobs = runningRaw
            .map((item) => normalizeQueueJob(item, "running"))
            .filter(Boolean);
          pendingJobs = pendingRaw
            .map((item) => normalizeQueueJob(item, "pending"))
            .filter(Boolean);
        }
      }

      const system = stats.system && typeof stats.system === "object" ? stats.system : {};
      // Device type only (cpu/cuda) — not VRAM totals (GPU panel owns those).
      const devicesRaw = Array.isArray(stats.devices) ? stats.devices : [];
      const deviceType =
        devicesRaw[0] && typeof devicesRaw[0] === "object" && devicesRaw[0].type != null
          ? String(devicesRaw[0].type)
          : null;

      this.error = null;
      return {
        available: true,
        port: this.port,
        version: system.comfyui_version != null ? String(system.comfyui_version) : null,
        pytorchVersion: system.pytorch_version != null ? String(system.pytorch_version) : null,
        deviceType,
        queueRunning: runningJobs.length,
        queuePending: pendingJobs.length,
        /** First running job (ComfyUI is single-executor); null when idle. */
        activeJob: runningJobs[0] || null,
        /** Up to a few pending jobs for “N waiting” detail. */
        pendingJobs: pendingJobs.slice(0, 5),
        error: null,
      };
    } catch (err) {
      this.error = err?.message || String(err);
      return this._default();
    }
  }

  _default() {
    return {
      available: false,
      port: this.port,
      version: null,
      pytorchVersion: null,
      deviceType: null,
      queueRunning: 0,
      queuePending: 0,
      activeJob: null,
      pendingJobs: [],
      error: this.error,
    };
  }
}
