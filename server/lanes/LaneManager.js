/**
 * LaneManager — async job runner for spark-lane up/down/verify/batch.
 *
 * Mirrors the proven DecodeBenchManager shape (start/get/list/cancel, bounded
 * history, fire-and-forget run with the client polling GET). Differences:
 *
 *  - SINGLE-FLIGHT IS FLEET-WIDE, not per-spark. A lane spans 3–4 nodes, so two
 *    concurrent operations can wedge the fleet. One active job at a time, period.
 *  - It runs a BASH PROCESS (the spark-lane harness), not HTTP. All lane
 *    correctness (occupancy guards, recipe fidelity, canary verify, no auto-restart)
 *    lives in the harness; this module only sequences and reports. It never
 *    reimplements lane logic.
 *  - PROJECT RULE: the server never issues an up/down the user did not ask for.
 *    Blockers are REPORTED (via plan()), never auto-resolved. The only ordering it
 *    applies is downs-before-ups inside one explicitly-requested batch, because
 *    freeing nodes first is physically required.
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { ROOT, SPARK_LANE_PATH, SPARK_LANE_TIMEOUT_MS } from "../config.js";
import { getLaneInventory } from "../collectors/LaneControl.js";

const VERBS = new Set(["up", "down", "verify"]);
const LOG_LIMIT = 500; // lines of harness output kept per job
const HISTORY_LIMIT = 30;
const BENCH_DIR = path.dirname(SPARK_LANE_PATH);
/** Sentinel held in `active` while a start() is validating but not yet running. */
const RESERVING = "__reserving__";

/** Strip private fields before returning a job to clients. */
function publicJob(job) {
  const { _child, _failed, _cancelled, ...rest } = job;
  return rest;
}

function appendLog(job, chunk) {
  const text = String(chunk);
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return;
  for (const l of lines) job.progress.log.push(l);
  if (job.progress.log.length > LOG_LIMIT) {
    job.progress.log.splice(0, job.progress.log.length - LOG_LIMIT);
  }
  // Surface the harness's "[n/N] step …" lines as a one-line progress hint.
  const step = [...lines].reverse().find((l) => /\[\d+\/\d+\]/.test(l));
  if (step) job.progress.step = step.trim();
  job.progress.message = lines[lines.length - 1].trim().slice(0, 200);
}

export class LaneManager {
  constructor(auditPath = process.env.LANE_AUDIT_PATH || path.join(ROOT, "logs", "lane-control.jsonl")) {
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    /** @type {object[]} finished jobs, newest first */
    this.history = [];
    /** @type {string | null} jobId of the single running job */
    this.active = null;
    this.auditPath = auditPath;
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (job) return publicJob(job);
    const found = this.history.find((j) => j.jobId === jobId);
    return found || null;
  }

  getActive() {
    if (!this.active) return null;
    const job = this.jobs.get(this.active);
    return job ? publicJob(job) : null;
  }

  /** Active job (if any) + recent history. */
  list() {
    return {
      active: this.getActive(),
      // True during the validation window between start() being called and the job
      // existing: `active` is still null then, so without this a client sees
      // "nothing running" while a second attempt is correctly refused with 409.
      reserving: this.active === RESERVING,
      history: this.history.slice(0, HISTORY_LIMIT),
    };
  }

  /**
   * Node-disjointness gate (spec §2.5). Pure check, no side effects.
   *
   * Two lanes can be up together iff their node sets are disjoint. A batch is
   * launchable iff, after removing the nodes freed by its `down` list, every lane
   * in `up` finds its nodes free AND the `up` lanes are pairwise disjoint.
   *
   * @param {{up?: string[], down?: string[]}} req
   * @returns {Promise<{launchable: boolean, blocked: object[], freed: string[]}>}
   */
  async plan({ up = [], down = [] } = {}, { force = false } = {}) {
    // `force` re-reads the harness instead of using the ~20s cache. Anything that
    // gates a destructive action must pass force:true — deciding whether the fleet
    // is clear from a 20s-old snapshot is how you launch on top of a live lane.
    const inventory = await getLaneInventory({ force });
    const byId = new Map(inventory.map((l) => [l.id, l]));
    const unknown = [...up, ...down].filter((id) => !byId.has(id));
    if (unknown.length) {
      const err = new Error(`unknown lane(s): ${unknown.join(", ")}`);
      err.status = 400;
      throw err;
    }

    // Effective occupancy: live holders, minus nodes freed by requested `down`s.
    const downSet = new Set(down);
    const effective = new Map(); // node -> lane holding it after downs
    for (const lane of inventory) {
      for (const [node, holder] of Object.entries(lane.holders || {})) {
        if (downSet.has(holder)) continue; // will be freed
        effective.set(node, holder);
      }
    }

    const upSet = [...new Set(up)];
    const blocked = [];

    // 1) each up lane's nodes must be free (after downs)
    for (const laneId of upSet) {
      for (const node of byId.get(laneId).nodes) {
        const holder = effective.get(node);
        if (holder && holder !== laneId) {
          blocked.push({ reason: "node-held", lane: laneId, node, holder });
        }
      }
    }

    // 2) the up lanes must be pairwise disjoint
    for (let i = 0; i < upSet.length; i++) {
      for (let j = i + 1; j < upSet.length; j++) {
        const a = byId.get(upSet[i]);
        const b = byId.get(upSet[j]);
        const shared = a.nodes.filter((n) => b.nodes.includes(n));
        if (shared.length) {
          blocked.push({ reason: "mutual-overlap", lanes: [a.id, b.id], nodes: shared });
        }
      }
    }

    return {
      launchable: blocked.length === 0,
      blocked,
      freed: inventory
        .filter((l) => downSet.has(l.id) && l.status === "up")
        .flatMap((l) => l.nodes),
      // The snapshot this verdict was computed from. Pass it to start() so the job
      // is validated against the SAME read the gate approved — one fleet sweep
      // instead of two, and no window between the two reads.
      inventory,
    };
  }

  /**
   * Start a job. Throws 409 while another job is running (fleet-wide single-flight).
   * @param {{verb: string, lane?: string, up?: string[], down?: string[], source?: string}} req
   */
  async start(req, { inventory: providedInventory = null } = {}) {
    if (this.active) {
      const err = new Error("A lane operation is already running");
      err.status = 409;
      err.activeJobId = this.active === RESERVING ? null : this.active;
      throw err;
    }

    // Claim the slot SYNCHRONOUSLY, before the first await. Every validation below
    // yields the event loop (the inventory call shells out to the harness), so
    // without this reservation two requests arriving in the same tick both clear
    // the check above and both go on to spawn lane operations 0.3ms apart — the
    // exact concurrency the fleet-wide single-flight exists to prevent.
    this.active = RESERVING;

    try {
      const verb = req.verb;
      const isBatch = verb === "batch";
      if (!isBatch && !VERBS.has(verb)) {
        const err = new Error(`invalid verb: ${verb}`);
        err.status = 400;
        throw err;
      }

      // Validate lanes against the harness inventory before doing anything.
      // Reuse the gate's snapshot when the caller supplied one (same read, one
      // sweep); otherwise force a fresh read — never validate a destructive action
      // against a cached fleet.
      const inventory = providedInventory || (await getLaneInventory({ force: true }));
      const known = new Set(inventory.map((l) => l.id));
      const lanes = isBatch ? [...new Set([...(req.up || []), ...(req.down || [])])] : [req.lane];
      const unknown = lanes.filter((id) => id && !known.has(id));
      if (unknown.length) {
        const err = new Error(`unknown lane(s): ${unknown.join(", ")}`);
        err.status = 400;
        throw err;
      }
      if (!isBatch && !req.lane) {
        const err = new Error("lane is required");
        err.status = 400;
        throw err;
      }
      if (isBatch && !(req.up || []).length && !(req.down || []).length) {
        const err = new Error("batch needs at least one lane in up or down");
        err.status = 400;
        throw err;
      }

      const jobId = randomUUID();
      const job = {
        jobId,
        verb: isBatch ? "batch" : verb,
        lane: isBatch ? null : req.lane,
        // Deduped: the gate and the id validation both collapse duplicates, so an
        // ["a","a"] payload must not run the same lane twice in one action.
        up: isBatch ? [...new Set(req.up || [])] : [],
        down: isBatch ? [...new Set(req.down || [])] : [],
        source: req.source || "api",
        status: "running",
        startedAt: Date.now(),
        completedAt: null,
        progress: { log: [], step: "", message: "Starting…" },
        steps: [], // {verb, lane, code, ok}
        result: { ok: null },
        error: null,
        _child: null,
        _failed: false,
      };

      this.jobs.set(jobId, job);
      this.active = jobId;

      this._run(job).catch(() => {
        /* errors are recorded on the job */
      });

      return publicJob(job);
    } catch (err) {
      // Release the reservation so a rejected request doesn't lock the fleet out.
      this.active = null;
      throw err;
    }
  }

  /** SIGTERM the running child. Status finalizes in _run's finally. */
  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status !== "running") return publicJob(job);
    job._cancelled = true;
    job.progress.message = "Cancelling…";
    try {
      job._child?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    return publicJob(job);
  }

  /** Run one harness invocation, streaming output into job.progress.log. */
  _execStep(job, verb, lane) {
    return new Promise((resolve) => {
      job.progress.step = `→ ${verb} ${lane}`;
      job.progress.message = `${verb} ${lane}…`;
      const child = spawn("/bin/bash", [SPARK_LANE_PATH, verb, lane], {
        cwd: BENCH_DIR,
        env: process.env,
      });
      job._child = child;

      // Node can emit 'error' and *then* 'close' for the same failure; without this
      // guard the step is recorded twice and the UI renders a duplicate ✗ line.
      let settled = false;
      let timer = null;
      const finish = (code, ok, note) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (!ok) job._failed = true;
        job.steps.push({ verb, lane, code, ok });
        job.progress.message = note;
        resolve(code);
      };

      // The deadline MUST settle here rather than waiting on 'close'. Node emits
      // 'close' only once the stdio pipes shut, and a detached grandchild can hold
      // them open long after the direct child exits — leaving this promise pending,
      // _run's finally unreachable, and `this.active` set forever: a permanent fleet
      // lockout that cancel() cannot clear (the direct child is already gone).
      // exit 124 mirrors timeout(1).
      timer = setTimeout(() => {
        appendLog(job, `\n[timeout] killing ${verb} ${lane} after ${SPARK_LANE_TIMEOUT_MS}ms`);
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        // Disown the child so a late 'close' can't double-record and its pipes can't
        // keep the event loop alive.
        try {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
        } catch {
          /* ignore */
        }
        finish(124, false, `${verb} ${lane} timed out after ${SPARK_LANE_TIMEOUT_MS}ms`);
      }, SPARK_LANE_TIMEOUT_MS);

      child.stdout.on("data", (b) => appendLog(job, b));
      child.stderr.on("data", (b) => appendLog(job, b));
      child.on("error", (e) => {
        appendLog(job, `[spawn error] ${e.message}`);
        finish(-1, false, `${verb} ${lane} spawn failed`);
      });
      child.on("close", (code) => {
        finish(code, code === 0, `${verb} ${lane} ${code === 0 ? "ok" : `failed (exit ${code})`}`);
      });
    });
  }

  async _run(job) {
    try {
      if (job.verb === "batch") {
        // Downs first — freeing nodes is physically required before ups.
        for (const lane of job.down) {
          if (job._cancelled) break;
          await this._execStep(job, "down", lane);
        }
        for (const lane of job.up) {
          if (job._cancelled) break;
          await this._execStep(job, "up", lane);
        }
      } else {
        await this._execStep(job, job.verb, job.lane);
      }
    } catch (e) {
      job.error = e?.message || String(e);
    } finally {
      // Status is decided here, once, so history is written a single time.
      if (job._cancelled) job.status = "cancelled";
      else if (job.error) job.status = "error";
      else job.status = job._failed ? "error" : "completed";

      job._child = null;
      job.completedAt = Date.now();
      job.result = { ok: job.status === "completed" };
      this.active = null;
      const { progress, ...hist } = publicJob(job);
      this.history.unshift({ ...hist, progress: { step: progress.step, message: progress.message } });
      if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
      // Keep the finished job in `jobs` so a client still polling getJob() receives
      // the final state WITH the full log. Prune old finished ones to bound memory.
      for (const [id, j] of this.jobs) {
        if (j.status !== "running" && id !== job.jobId) this.jobs.delete(id);
      }
      this._audit(job);
    }
  }

  /** Append one JSONL audit row: who took down / brought up what, and when. */
  _audit(job) {
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
      const row = {
        ts: new Date(job.completedAt).toISOString(),
        jobId: job.jobId,
        verb: job.verb,
        lane: job.lane,
        up: job.up,
        down: job.down,
        source: job.source,
        status: job.status,
        steps: job.steps,
        durationMs: job.completedAt - job.startedAt,
      };
      fs.appendFileSync(this.auditPath, JSON.stringify(row) + "\n");
    } catch (e) {
      console.warn("[LaneManager] audit write failed:", e?.message || e);
    }
  }
}

export const laneManager = new LaneManager();