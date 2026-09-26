import { strict as assert } from "node:assert";

/**
 * Assert a rate that was derived from a wall-clock window (`lastProbeTime =
 * Date.now() - 2000`) rather than from an injected dt.
 *
 * The probe computes `delta / dtSec`, where dtSec is the real elapsed time, then
 * rounds to 2dp. Exact equality therefore requires the ~2s window to land within
 * ~2.5ms of nominal — it holds when the file runs alone, and fails intermittently
 * once the suite runs several test files in parallel and the process gets
 * descheduled mid-test.
 *
 * The deltas in question are tens of tokens over ~2s, so a ±0.5 band still catches a
 * wrong delta or a wrong divisor while tolerating scheduler jitter. Verified by
 * injecting a doubled divisor into the probe: the assertion fails as it should.
 *
 * Do NOT use this for gauge-sourced rates (e.g. SGLang's `last_gen_throughput`) —
 * those carry no time dependency and belong on a plain exact assertion.
 */
export function assertRate(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) < 0.5,
    `${label}: got ${actual}, want ~${expected} (wall-clock Δt jitter)`,
  );
}