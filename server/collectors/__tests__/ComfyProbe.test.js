import test from "node:test";
import assert from "node:assert/strict";
import { ComfyProbe, summarizeComfyPrompt } from "../ComfyProbe.js";

test("ComfyProbe defaults when host unreachable", async () => {
  const probe = new ComfyProbe(
    { isLocal: true, lanIp: "127.0.0.1" },
    1 // nothing listens on port 1
  );
  const snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.equal(snap.port, 1);
  assert.equal(snap.queueRunning, 0);
  assert.equal(snap.queuePending, 0);
  assert.equal(snap.activeJob, null);
  assert.ok(snap.error);
});

test("ComfyProbe setTarget updates port and host", () => {
  const probe = new ComfyProbe({ isLocal: false, lanIp: "10.0.0.5" }, 8188);
  assert.match(probe.baseUrl, /10\.0\.0\.5:8188/);
  probe.setTarget({ isLocal: true, lanIp: "10.0.0.5" }, 9001);
  assert.equal(probe.port, 9001);
  assert.match(probe.baseUrl, /127\.0\.0\.1:9001/);
});

test("summarizeComfyPrompt extracts models and footprint", () => {
  const summary = summarizeComfyPrompt({
    "3": {
      class_type: "KSampler",
      inputs: {
        steps: 20,
        sampler_name: "euler",
        model: ["4", 0],
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "models/checkpoints/v1-5-pruned-emaonly.safetensors" },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: 512, height: 768, batch_size: 2 },
    },
    "6": {
      class_type: "LoraLoader",
      inputs: { lora_name: "style.safetensors", strength_model: 0.8 },
    },
  });

  assert.equal(summary.nodeCount, 4);
  assert.equal(summary.steps, 20);
  assert.equal(summary.width, 512);
  assert.equal(summary.height, 768);
  assert.equal(summary.batchSize, 2);
  assert.equal(summary.sampler, "euler");
  assert.deepEqual(summary.models, [
    "v1-5-pruned-emaonly.safetensors",
    "style.safetensors",
  ]);
});

test("ComfyProbe parses running queue item into activeJob", async () => {
  const prompt = {
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "flux1-dev.safetensors" },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: 1024, height: 1024, batch_size: 1 },
    },
    "3": {
      class_type: "KSampler",
      inputs: { steps: 28, sampler_name: "euler" },
    },
  };
  const queueItem = [
    0,
    "a1b2c3d4-e5f6-7a89-b0c1-d2e3f4a5b6c7",
    prompt,
    {
      create_time: Date.now() - 5000,
      extra_pnginfo: { workflow: { title: "Portrait run" } },
    },
    [],
  ];

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/system_stats")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          system: {
            comfyui_version: "0.29.0",
            pytorch_version: "2.13.0+cpu",
          },
          devices: [{ type: "cpu", name: "cpu" }],
        }),
      };
    }
    if (u.endsWith("/queue")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          queue_running: [queueItem],
          queue_pending: [],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  try {
    const probe = new ComfyProbe({ isLocal: true }, 8188);
    const snap = await probe.probe();
    assert.equal(snap.available, true);
    assert.equal(snap.queueRunning, 1);
    assert.ok(snap.activeJob);
    assert.equal(snap.activeJob.title, "Portrait run");
    assert.equal(snap.activeJob.steps, 28);
    assert.equal(snap.activeJob.width, 1024);
    assert.deepEqual(snap.activeJob.models, ["flux1-dev.safetensors"]);
    assert.equal(snap.deviceType, "cpu");
    assert.equal(snap.ramTotal, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});
