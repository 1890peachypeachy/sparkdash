/**
 * Lane control — read-only lane inventory for the sparkDash lane panel.
 *
 * This server is a FRONT END over the proven `spark-lane` harness
 * (~/recipe-db/spark-bench/ops/spark-lane), never a reimplementation. All lane
 * correctness (occupancy guards, recipe fidelity, canary verify, "no auto-restart")
 * lives in the harness. We shell out to it and parse its JSON.
 *
 * Phase 1 is read-only: `lanes --json` and `status --json` only. No up/down is
 * issued from here yet — the destructive verbs land in Phase 2 behind the
 * node-disjointness gate and a confirm.
 *
 * execFile + argv arrays (no shell interpolation) — never string-concat a path or
 * lane id into a shell.
 */
import { execFile } from "child_process";
import fs from "fs";
import { SPARK_LANE_PATH, SPARK_LANE_TIMEOUT_MS, LANE_STATUS_TTL_MS } from "../config.js";

/** Run the harness with args, resolve stdout text. Rejects on non-zero exit. */
function runSparkLane(args) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SPARK_LANE_PATH)) {
      const err = new Error(`spark-lane not found at ${SPARK_LANE_PATH}`);
      err.status = 503;
      return reject(err);
    }
    execFile(
      "/bin/bash",
      [SPARK_LANE_PATH, ...args],
      { timeout: SPARK_LANE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          error.status = 502;
          return reject(error);
        }
        resolve(stdout);
      }
    );
  });
}

/** Parse stdout as JSON, or throw a 502 the route can surface. */
function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`spark-lane ${what} returned non-JSON output`);
    err.status = 502;
    throw err;
  }
}

// ─── Short TTL cache ─────────────────────────────────────
// The inventory shells out over SSH to all four nodes, so a panel auto-refresh
// every couple of seconds must not fan out an SSH storm. One call per TTL.
let cache = { at: 0, lanes: null, status: null };

/** @returns {Promise<Array<object>>} lane inventory (id, nodes, endpoint, model, status, holders) */
export async function getLaneInventory({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.lanes && now - cache.at < LANE_STATUS_TTL_MS) return cache.lanes;
  const lanes = parseJson(await runSparkLane(["lanes", "--json"]), "lanes");
  cache = { at: now, lanes, status: cache.status };
  return lanes;
}

/** @returns {Promise<{nodes: object, lanes: Array<object>}>} live census */
export async function getLaneStatus({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.status && now - cache.at < LANE_STATUS_TTL_MS) return cache.status;
  const status = parseJson(await runSparkLane(["status", "--json"]), "status");
  cache = { at: now, lanes: cache.lanes, status };
  return status;
}