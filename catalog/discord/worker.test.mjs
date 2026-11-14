import assert from "node:assert/strict";
import test from "node:test";
import { handleInteraction } from "./worker.mjs";

const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const env = {
  DISCORD_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex"),
  DISCORD_APPLICATION_ID: "123456789012345678",
  DISCORD_GUILD_ID: "987654321098765432",
  GITHUB_ACTIONS_TOKEN: "fixture-token",
};

async function signed(data, { secondsAgo = 0, tampered = false } = {}) {
  const body = JSON.stringify({ application_id: env.DISCORD_APPLICATION_ID, ...data });
  const timestamp = String(Math.floor(Date.now() / 1000) - secondsAgo);
  const signature = await crypto.subtle.sign("Ed25519", keys.privateKey, Buffer.from(timestamp + body));
  return new Request("https://fixture.invalid/interactions", {
    method: "POST",
    body: body + (tampered ? " " : ""),
    headers: { "x-signature-timestamp": timestamp, "x-signature-ed25519": Buffer.from(signature).toString("hex") },
  });
}

test("handles Discord PING and rejects invalid and expired signatures", async () => {
  assert.deepEqual(await (await handleInteraction(await signed({ type: 1 }), env, {})).json(), { type: 1 });
  assert.equal((await handleInteraction(await signed({ type: 1 }, { tampered: true }), env, {})).status, 401);
  assert.equal((await handleInteraction(await signed({ type: 1 }, { secondsAgo: 600 }), env, {})).status, 401);
});

test("dispatches only for administrators on the configured server", async () => {
  const command = { type: 2, guild_id: env.DISCORD_GUILD_ID, member: { permissions: "0" },
    token: "fixture", data: { name: "hub-sync", options: [{ name: "appid", value: 3527290 }] } };
  let background;
  const ctx = { waitUntil: task => { background = task; } };
  assert.equal((await (await handleInteraction(await signed(command), env, ctx)).json()).type, 4);
  assert.equal(background, undefined);
  command.member.permissions = "8";
  const calls = [];
  const ack = await handleInteraction(await signed(command), env, ctx, async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return Response.json({ workflow_run_id: 5 });
  });
  assert.equal((await ack.json()).type, 5);
  await background;
  assert.deepEqual(calls[0][1], { ref: "main", inputs: { app_id: "3527290" } });
  assert.match(calls[0][0], /kiyotec\/AVerseHub\/actions\/workflows\/steam-catalog\.yml\/dispatches$/);
  assert.match(calls[1][1].content, /runs\/5/);
});

test("routes both bundle commands to the Hubcap workflow and requires an AppID", async () => {
  const command = { type: 2, guild_id: env.DISCORD_GUILD_ID, member: { permissions: "8" }, token: "fixture" };
  let background;
  const context = { waitUntil: task => { background = task; } };
  for (const name of ["hubget", "hubupdate"]) {
    const ack = await handleInteraction(await signed({
      ...command, data: { name, options: [{ name: "appid", value: 3527290 }] },
    }), env, context, async (url, options) => {
      if (options.method === "POST") {
        assert.match(url, /hubcap-bundles\.yml\/dispatches$/);
        assert.equal(JSON.parse(options.body).inputs.app_id, "3527290");
        return Response.json({ workflow_run_id: 5 });
      }
      return Response.json({});
    });
    assert.equal((await ack.json()).type, 5);
    await background;
  }
  const invalid = await handleInteraction(await signed({ ...command, data: { name: "hubget" } }), env, {});
  assert.match((await invalid.json()).data.content, /AppID/);
});

test("runs discovery and reads workflow or AppID status", async () => {
  const command = { type: 2, guild_id: env.DISCORD_GUILD_ID, member: { permissions: "8" }, token: "fixture" };
  let background;
  const context = { waitUntil: task => { background = task; } };
  for (const [name, value, expectedPath, upstream, expectedReply] of [
    ["hubscan", undefined, /hubcap-bundles\.yml\/dispatches$/, { workflow_run_id: 5 }, /runs\/5/],
    ["hubstatus", undefined, /hubcap-bundles\.yml\/runs\?branch=main&per_page=1$/, { workflow_runs: [{ id: 7, run_number: 3, conclusion: "success" }] }, /thành công.*runs\/7/],
    ["hubstatus", 3527290, /contents\?ref=3527290$/, [{ type: "file", name: "3527290.lua" }, { type: "file", name: "3527291_123.manifest" }], /có Lua.*1 manifest/],
    ["hubstatus", 1, /contents\?ref=1$/, null, /Chưa có nhánh AppID 1/],
  ]) {
    const data = { name, options: value ? [{ name: "appid", value }] : [] };
    let reply;
    const response = await handleInteraction(await signed({ ...command, data }), env, context, async (url, options) => {
      if (options.method === "PATCH") {
        reply = JSON.parse(options.body).content;
        return Response.json({});
      }
      assert.match(url, expectedPath);
      if (name === "hubscan") assert.deepEqual(JSON.parse(options.body), { ref: "main", inputs: { app_id: "" } });
      else assert.equal(options.method, "GET");
      return upstream ? Response.json(upstream) : new Response(null, { status: 404 });
    });
    assert.equal((await response.json()).type, 5);
    await background;
    assert.match(reply, expectedReply);
  }
});
