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
