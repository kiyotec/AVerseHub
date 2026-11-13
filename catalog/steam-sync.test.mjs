import assert from "node:assert/strict";
import test from "node:test";
import { fetchSteamApp, fetchSteamApps } from "./steam-sync.mjs";

test("syncs pages in order and retains previous metadata", async () => {
  const old = { cursor: 10000, apps: [{ appId: 5, name: "Before", type: "game" }, { appId: 10, name: "Unchanged" }] };
  const calls = [];
  const result = await fetchSteamApps("test-key", old, async (url, headers) => {
    assert.equal(url.host, "api.steampowered.com");
    assert.equal(url.searchParams.has("key"), false);
    assert.equal(headers["x-webapi-key"], "test-key");
    const params = JSON.parse(url.searchParams.get("input_json"));
    calls.push(params);
    return { response: calls.length === 1
      ? { apps: [{ appid: 5, name: "After", last_modified: 12345 }], have_more_results: true, last_appid: 5 }
      : { apps: [{ appid: 42, name: "New", last_modified: 12346 }] } };
  }, 15000);
  assert.equal(calls[0].if_modified_since, 6400);
  assert.equal(calls[1].last_appid, 5);
  assert.equal(result.cursor, 15000);
  assert.deepEqual(result.apps.map(app => [app.appId, app.name]), [[5, "After"], [10, "Unchanged"], [42, "New"]]);
  assert.equal(result.apps[0].type, "game");
});

test("rejects empty initial data and broken pagination", async () => {
  const previous = { cursor: 0, apps: [] };
  await assert.rejects(fetchSteamApps("test-key", previous, async () => ({ response: {} })), /empty/);
  await assert.rejects(fetchSteamApps("test-key", previous, async () => ({
    response: { apps: [{ appid: 5, name: "Example" }], have_more_results: true, last_appid: 4 },
  })), /cursor/);
});

test("validates the Store identity for individual AppIDs", async () => {
  const data = { success: true, data: { steam_appid: 5, name: "Example", type: "game" } };
  assert.deepEqual(await fetchSteamApp(5, async () => ({ 5: data })), { appId: 5, name: "Example", type: "game" });
  await assert.rejects(fetchSteamApp(6, async () => ({ 6: data })), /matching public entry/);
  await assert.rejects(fetchSteamApp(0x100000000), /uint32/);
});
