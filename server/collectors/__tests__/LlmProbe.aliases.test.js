/**
 * Our fork's addition on top of upstream's Strata-alias rule: several served ids that share one weights
 * root and one max_model_len are aliases of a single loaded engine (gr8 lists GLM-5.3-Flash-EXL3 / glm-5.3 /
 * glm53), so the probe reports that shared limit instead of hiding it. Genuine multi-model routers, whose
 * limits differ, still report no context length.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

const res = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const notFound = () => res({}, 404);
const PROM = [
  'vllm:num_requests_running{model_name="m"} 0',
  'vllm:num_requests_waiting{model_name="m"} 0',
  'vllm:generation_tokens_total{model_name="m"} 100',
  'vllm:prompt_tokens_total{model_name="m"} 100',
].join("\n");

async function probeWith(models) {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe._fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v1/models") return res({ data: models });
    if (path === "/metrics") return res(PROM);
    return notFound();
  };
  return probe.probe();
}

const ROOT = "/var/lib/gr8/cache/hf/model/tokenizer";

test("aliases with one root and one max_model_len share that context length", async () => {
  const snap = await probeWith([
    { id: "GLM-5.3-Flash-EXL3", max_model_len: 1048562, root: ROOT, owned_by: "gr8" },
    { id: "glm-5.3", max_model_len: 1048562, root: ROOT, owned_by: "gr8" },
    { id: "glm53", max_model_len: 1048562, root: ROOT, owned_by: "gr8" },
  ]);
  assert.equal(snap.available, true);
  assert.equal(snap.models.length, 3);
  assert.equal(snap.contextLength, 1048562);
});

test("models with different limits are a router, not aliases: no context length", async () => {
  const snap = await probeWith([
    { id: "big", max_model_len: 1048562, root: ROOT },
    { id: "small", max_model_len: 32768, root: ROOT },
  ]);
  assert.equal(snap.models.length, 2);
  assert.equal(snap.contextLength, null);
});

test("models with different weights roots are not aliases even at the same limit", async () => {
  const snap = await probeWith([
    { id: "a", max_model_len: 262144, root: "/models/a" },
    { id: "b", max_model_len: 262144, root: "/models/b" },
  ]);
  assert.equal(snap.contextLength, null);
});
