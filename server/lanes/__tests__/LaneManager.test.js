/**
 * Regression tests for the lane-control safety properties. These are the tests
 * that were missing when the single-flight race (bug 1) was fixed: `npm test`
 * covered only collectors/ and sparks/, so nothing here was exercised.
 *
 * Every test runs against the stub harness in ./fixtures — no real node, no real
 * fleet, and (via LANE_AUDIT_PATH) no writes to logs/lane-control.jsonl.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lane-mgr-"));

// Stage the stub and point the module at it BEFORE importing: config.js resolves
// SPARK_LANE_PATH at import time, and the audit path must never be the live ledger.
const STUB = path.join(DIR, "spark-lane");
fs.copyFileSync(path.join(HERE, "fixtures", "spark-lane-stub.sh"), STUB);
fs.chmodSync(STUB, 0o755);
const LOG = path.join(DIR, "invocations.log");
const AUDIT = path.join(DIR, "audit.jsonl");

process.env.SPARK_LANE_PATH = STUB;
process.env.LANE_STUB_LOG = LOG;
process.env.LANE_AUDIT_PATH = AUDIT;
process.env.SPARK_LANE_TIMEOUT_MS = "1500";

const { LaneManager } = await import("../LaneManager.js");

const lane = (id, nodes, status, holders = {}) => ({ id, nodes, status, holders, endpoint: `http://${id}`, model: id });

/**
 * tp4 needs all four nodes and is DOWN; tp3 {spark1,spark3,spark4} and creative
 * {spark2} are UP.
 *
 * `holders` is NOT "the lanes I hold" — it is "the lanes blocking me, excluding my
 * own claim". So an UP lane reports `{}` for itself, while a DOWN lane names, per
 * node, the live lane occupying it. Inverting this fixture makes the gate look
 * broken when it is right.
 */
const TWO_UP = [
  lane("tp4", ["spark1", "spark2", "spark3", "spark4"], "down", {
    spark1: "tp3", spark2: "creative", spark3: "tp3", spark4: "tp3",
  }),
  lane("tp3", ["spark1", "spark3", "spark4"], "up"),
  lane("creative", ["spark2"], "up"),
];

/** Two DOWN lanes that overlap on spark1 — for the mutual-overlap rule. */
const OVERLAP = [
  lane("tp4", ["spark1", "spark2"], "down"),
  lane("tp3", ["spark1", "spark3"], "down"),
];

function setState(lanes) {
  process.env.LANE_STUB_LANES = JSON.stringify(lanes);
  process.env.LANE_STUB_MODE = "normal";
  process.env.LANE_STUB_EXIT = "0";
}

/** Harness invocations recorded so far (one line per up/down/verify). */
function invocations() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, "utf8").split("\n").filter((l) => l.startsWith("INVOKED"));
}

function reset() {
  fs.writeFileSync(LOG, "");
  setState(TWO_UP);
}

/**
 * plan() with force:true. The inventory cache is module-level with a ~20s TTL, so
 * without this every test after the first would be judged against the previous
 * test's fleet. The real routes pass force:true for the same reason.
 */
const gate = (lm, req) => lm.plan(req, { force: true });

/** Poll until a job reaches a terminal status (or the deadline passes). */
async function waitDone(lm, jobId, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const j = lm.getJob(jobId);
    if (j && j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 50));
  }
  return lm.getJob(jobId);
}

// ---------------------------------------------------------------------------
// Single-flight
// ---------------------------------------------------------------------------

test("two starts in the same tick: exactly one accepted, the other 409", async () => {
  reset();
  const lm = new LaneManager();

  // Both start() calls are entered synchronously before either is awaited, which
  // is the double-click / second-tab case. Pre-fix both cleared the `if (this.active)`
  // check (it ran before the first await) and both spawned harness processes.
  const [a, b] = await Promise.allSettled([
    lm.start({ verb: "up", lane: "tp3" }),
    lm.start({ verb: "up", lane: "tp3" }),
  ]);

  const accepted = [a, b].filter((r) => r.status === "fulfilled");
  const rejected = [a, b].filter((r) => r.status === "rejected");
  assert.equal(accepted.length, 1, "exactly one start must be accepted");
  assert.equal(rejected.length, 1, "the other must be refused");
  assert.equal(rejected[0].reason.status, 409);

  const job = await waitDone(lm, accepted[0].value.jobId);
  assert.equal(job.status, "completed");
  assert.equal(invocations().length, 1, "only ONE harness process may run");
});

test("a rejected start releases the slot — a bad request cannot lock the fleet out", async () => {
  reset();
  const lm = new LaneManager();

  const bad = [
    { verb: "bogus", lane: "tp3" },          // invalid verb
    { verb: "up" },                          // missing lane
    { verb: "up", lane: "nope" },            // unknown lane
    { verb: "batch", up: [], down: [] },     // empty batch
  ];
  for (const req of bad) {
    await assert.rejects(() => lm.start(req), (e) => e.status === 400);
    assert.equal(lm.active, null, `slot must be free after ${JSON.stringify(req)}`);
    assert.equal(lm.list().reserving, false);
  }

  // The fleet is still usable after four rejected requests.
  const job = await lm.start({ verb: "up", lane: "tp3" });
  assert.ok(job.jobId);
  await waitDone(lm, job.jobId);
});

test("the slot clears when a job finishes, so the next action is accepted", async () => {
  reset();
  const lm = new LaneManager();
  const j1 = await lm.start({ verb: "up", lane: "tp3" });
  await waitDone(lm, j1.jobId);
  assert.equal(lm.active, null);
  const j2 = await lm.start({ verb: "up", lane: "creative" });
  assert.ok(j2.jobId);
  await waitDone(lm, j2.jobId);
});

// ---------------------------------------------------------------------------
// Node-disjointness gate (spec §2.5)
// ---------------------------------------------------------------------------

test("gate: tp3 + creative can co-tenant; tp4 is held by both", async () => {
  reset();
  const lm = new LaneManager();

  assert.equal((await gate(lm,{ up: ["tp3"], down: [] })).launchable, true);
  assert.equal((await gate(lm,{ up: ["creative"], down: [] })).launchable, true);
  assert.equal((await gate(lm,{ up: ["tp3", "creative"], down: [] })).launchable, true);

  // tp4 needs all four nodes, held by the two live lanes.
  const blockedPlan = await gate(lm,{ up: ["tp4"], down: [] });
  assert.equal(blockedPlan.launchable, false);
  assert.equal(blockedPlan.blocked.length, 4);
  assert.ok(blockedPlan.blocked.every((b) => b.reason === "node-held"));

  // Freeing tp3 is not enough — creative still holds spark2.
  assert.equal((await gate(lm,{ up: ["tp4"], down: ["tp3"] })).launchable, false);
});

test("gate: tearing both live lanes down frees the fleet for tp4", async () => {
  reset();
  const lm = new LaneManager();
  const plan = await gate(lm,{ up: ["tp4"], down: ["tp3", "creative"] });
  assert.equal(plan.launchable, true);
  assert.deepEqual(plan.freed.sort(), ["spark1", "spark2", "spark3", "spark4"]);
});

test("gate: two up lanes sharing a node are refused as mutual-overlap", async () => {
  reset();
  setState(OVERLAP);
  const lm = new LaneManager();
  const plan = await gate(lm,{ up: ["tp4", "tp3"], down: [] });
  assert.equal(plan.launchable, false);
  const overlap = plan.blocked.find((b) => b.reason === "mutual-overlap");
  assert.ok(overlap, "expected a mutual-overlap blocker");
  assert.deepEqual(overlap.nodes, ["spark1"]);
});

test("gate: an unknown lane id is a 400", async () => {
  reset();
  const lm = new LaneManager();
  await assert.rejects(() => gate(lm,{ up: ["ghost"] }), (e) => e.status === 400);
});

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

test("a step whose grandchild holds the pipe still settles at the timeout", async () => {
  reset();
  process.env.LANE_STUB_MODE = "hang"; // parent exits, grandchild keeps stdout open
  const lm = new LaneManager();

  const job = await lm.start({ verb: "up", lane: "tp3" });
  const done = await waitDone(lm, job.jobId, 4000);

  // The deadline (1500ms) must settle the step on its own. If the step instead
  // waited for 'close', it would still be running here (the pipe closes at ~6s),
  // `_run` would never reach its finally, and `active` would stay set forever.
  assert.notEqual(done.status, "running", "the timeout must settle the step");
  assert.equal(done.steps.length, 1, "the step is recorded exactly once");
  assert.equal(done.steps[0].code, 124, "timeout uses the timeout(1) exit code");
  assert.equal(lm.active, null, "the fleet slot must be released");
  assert.equal(lm.list().reserving, false);
});

test("a duplicate lane id in one batch runs once", async () => {
  reset();
  setState(OVERLAP);
  const lm = new LaneManager();
  const job = await lm.start({ verb: "batch", up: ["tp4", "tp4"], down: [] });
  assert.deepEqual(job.up, ["tp4"], "the job payload must be deduped");
  const done = await waitDone(lm, job.jobId);
  assert.equal(done.status, "completed");
  assert.equal(invocations().length, 1, "one bring-up, not two");
});

test("job payloads do not leak internal fields", async () => {
  reset();
  const lm = new LaneManager();
  const job = await lm.start({ verb: "up", lane: "tp3" });
  for (const field of ["_cancelled", "_child", "_failed"]) {
    assert.ok(!(field in job), `${field} must not be serialised`);
  }
  await waitDone(lm, job.jobId);
});

// ---------------------------------------------------------------------------
// Audit ledger isolation
// ---------------------------------------------------------------------------

test("audit rows go to LANE_AUDIT_PATH, never the live ledger", async () => {
  reset();
  fs.writeFileSync(AUDIT, "");
  const lm = new LaneManager();
  const job = await lm.start({ verb: "up", lane: "tp3" });
  await waitDone(lm, job.jobId);

  const rows = fs.readFileSync(AUDIT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "completed");
});