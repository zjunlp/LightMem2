import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { reserveUnusedPort, withTempHome } from "@lightmem2/host-adapter";
import { requestUpstreamResponses } from "./upstream-transport-fetch.js";

test("openclaw upstream transport caches unsupported prompt_cache_retention and skips retry later", async () => {
  await withTempHome("lightmem2-openclaw-upstream-capability-", async (homeDir) => {
    const upstreamPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".openclaw", "tokenpilot-state");
    const requests: Array<Record<string, unknown>> = [];

    const upstream = createHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(payload);

      if ("prompt_cache_retention" in payload) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          error: {
            message: "Unsupported parameter: prompt_cache_retention",
            type: "bad_response_status_code",
            param: "",
            code: "bad_response_status_code",
          },
        }));
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: `resp-openclaw-${requests.length}`,
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
      }));
    });

    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(upstreamPort, "127.0.0.1", () => {
        upstream.off("error", reject);
        resolve();
      });
    });

    try {
      const logger = {
        warn: () => undefined,
        error: () => undefined,
      };
      const upstreamConfig = {
        providerId: "test-upstream",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: "test-key",
        apiFamily: "openai-responses",
        models: [],
      };
      const payload = {
        model: "gpt-5.4-mini",
        stream: false,
        prompt_cache_key: "runtime-pfx-test",
        prompt_cache_retention: "24h",
        input: [{ role: "user", content: "hello" }],
      };

      const first = await requestUpstreamResponses(upstreamConfig, payload, logger, stateDir);
      const second = await requestUpstreamResponses(upstreamConfig, payload, logger, stateDir);

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(requests.length, 3);
      assert.equal(requests[0]?.prompt_cache_retention, "24h");
      assert.equal("prompt_cache_retention" in (requests[1] ?? {}), false);
      assert.equal("prompt_cache_retention" in (requests[2] ?? {}), false);
      assert.equal(requests[0]?.prompt_cache_key, "runtime-pfx-test");
      assert.equal(requests[1]?.prompt_cache_key, "runtime-pfx-test");
      assert.equal(requests[2]?.prompt_cache_key, "runtime-pfx-test");

      const capabilityRaw = await readFile(
        join(
          stateDir,
          "upstream-capabilities",
          "responses",
          encodeURIComponent(`http://127.0.0.1:${upstreamPort}/v1/responses`) + ".json",
        ),
        "utf8",
      );
      const capability = JSON.parse(capabilityRaw) as { unsupportedOptionalFields?: string[] };
      assert.deepEqual(capability.unsupportedOptionalFields, ["prompt_cache_retention"]);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
