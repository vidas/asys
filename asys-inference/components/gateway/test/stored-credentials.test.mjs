import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAccountRuntime } from "../src/catalogue.mjs";
import { readCredentialAccounts } from "../src/credentials.mjs";

// The credentials volume outlives gateway images: an update mounts the same
// auth.json into a gateway built with a newer Pi. Each fixture is an auth.json
// as written under one earlier Pi release. When changing the Pi pin, add the
// replaced release's fixture; every fixture must keep authenticating requests.
const FIXTURES = new URL("./fixtures/stored-credentials/", import.meta.url);

for (const name of (await readdir(FIXTURES)).filter((file) => file.endsWith(".json")).sort()) {
  test(`credentials stored under ${name.slice(0, -5)} authenticate requests`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cyclo-gateway-stored-credentials-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const authPath = join(root, "auth.json");
    await copyFile(new URL(name, FIXTURES), authPath);
    const stored = JSON.parse(await readFile(authPath, "utf8"));
    const upstream = await recordingUpstream(t);
    offlineExceptLocal(t);

    const accounts = readCredentialAccounts(authPath);
    assert.deepEqual(accounts.map(({ account }) => account).sort(), Object.keys(stored).sort());
    for (const { account, provider } of accounts) {
      const runtime = createAccountRuntime({ account, provider, authPath });
      await runtime.models.refresh({ allowNetwork: false, providers: [provider] });
      const [model] = await runtime.models.getAvailable(provider);
      assert.ok(model, `${account} has no available model`);
      const events = runtime.models.streamSimple({ ...model, baseUrl: upstream.url },
        { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, { maxRetries: 0 });
      for await (const event of events) if (event.type === "done" || event.type === "error") break;

      const requests = upstream.requests.splice(0);
      assert.ok(requests.length > 0, `${account} sent no request`);
      const credential = stored[account];
      const secret = credential.type === "oauth" ? credential.access : credential.key;
      for (const headers of requests) {
        assert.equal(headers.authorization, `Bearer ${secret}`, `${account} lost its stored credential`);
        if (credential.accountId !== undefined) {
          assert.equal(headers["chatgpt-account-id"], credential.accountId);
        }
      }
    }
    // The fixture's lifetime is far in the future, so nothing was refreshed.
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), stored);
  });
}

async function recordingUpstream(t) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.headers);
    request.resume();
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "recorded" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

function offlineExceptLocal(t) {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== "127.0.0.1") throw new Error(`unexpected network request to ${url.origin}`);
    return original(input, init);
  };
  t.after(() => { globalThis.fetch = original; });
}
