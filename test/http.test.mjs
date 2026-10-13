import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
test(
  "HTTP fixture enforces actor isolation, idempotency, and versions",
  { timeout: 10000 },
  async () => {
    const p = spawn(process.execPath, [
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      "serve",
      "0",
    ]);
    const url = await new Promise((resolve, reject) => {
      p.on("error", reject);
      p.stderr.on("data", (d) => {
        const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (m) resolve(m[0]);
      });
      p.on("exit", () => reject(new Error("Server exited")));
    });
    const request = (method, path, body, actor = "alice") =>
      fetch(url + path, {
        method,
        headers: {
          "x-fixture-actor": actor,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    try {
      assert.equal(
        (await request("GET", "/tickets", undefined, "missing")).status,
        403,
      );
      const create = { title: "HTTP ticket", operationKey: "key" };
      const a = await (await request("POST", "/tickets", create)).json();
      const b = await (await request("POST", "/tickets", create)).json();
      assert.equal(a.id, b.id);
      assert.equal(
        (
          await request("PATCH", "/tickets/" + a.id, {
            status: "closed",
            expectedVersion: 0,
          })
        ).status,
        409,
      );
      const done = await (
        await request("PATCH", "/tickets/" + a.id, {
          status: "closed",
          expectedVersion: 1,
        })
      ).json();
      assert.equal(done.status, "closed");
      assert.equal((await (await request("GET", "/tickets")).json()).length, 1);
    } finally {
      p.kill("SIGTERM");
      await new Promise((r) => p.once("close", r));
    }
  },
);
