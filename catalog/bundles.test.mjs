import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fetchBundle } from "./fetch-bundle.mjs";
import { discover, publish, selectCandidates } from "./sync-bundles.mjs";

const python = process.env.PYTHON || "python";
const validator = fileURLToPath(new URL("./validate-bundle.py", import.meta.url));
const fixture = String.raw`
import struct, sys, zipfile
def section(magic, data):
    return struct.pack("<II", magic, len(data)) + data
gid = int(sys.argv[2])
manifest = (section(0x71f617d0, b"data") + section(0x1f4812be, bytes([8, 43, 16, gid]))
            + section(0x1b81b817, b"") + struct.pack("<I", 0x32c415ab))
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("42.lua", 'addappid(42)\naddappid(43,0,"' + "a"*64 + '")\nsetManifestid(43,"' + str(gid) + '")\n')
    z.writestr(f"43_{gid}.manifest", manifest)
    if len(sys.argv) > 3:
        z.writestr("../outside.lua", "bad")
`;

test("searches Hubcap and chooses new and changed bundles once per AppID", async () => {
  const now = Date.parse("2026-11-14T00:00:00Z");
  const rows = [1, 2, 3, 2].map((id, i) => ({ game_id: id, uploaded_date: `2026-11-${10 + i}`, manifest_available: true }));
  const state = { 1: { uploaded: Date.parse("2026-11-10"), commit: "same" }, 2: { uploaded: Date.parse("2026-11-01"), commit: "older" } };
  const results = await discover("test-key", async (url, options) => {
    assert.equal(`${url.origin}${url.pathname}`, "https://hubcapmanifest.com/api/v1/search");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(options.headers.authorization, "Bearer test-key");
    return Response.json({ results: url.searchParams.get("q") === "game" ? rows : [] });
  });
  assert.deepEqual(selectCandidates(results, new Map([["1", "same"], ["2", "older"]]), state, now).map(([id]) => id), ["2", "3"]);
});

test("downloads, validates and updates a numeric branch with fast-forward history", async () => {
  const temp = mkdtempSync(join(tmpdir(), "aversehub-test-"));
  const original = process.cwd();
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const local = join(temp, "local"), remote = join(temp, "remote");
    mkdirSync(local);
    git("init", "--bare", remote);
    process.chdir(local);
    git("init");
    git("remote", "add", "origin", remote);
    let head;
    for (const gid of [9, 10]) {
      const source = join(temp, `source-${gid}.zip`);
      execFileSync(python, ["-c", fixture, source, String(gid)]);
      const zip = await fetchBundle("42", join(temp, `download-${gid}`), "test-key", async (url, options) => {
        assert.equal(url.href, "https://hubcapmanifest.com/api/v1/manifest/42");
        assert.equal(options.headers.authorization, "Bearer test-key");
        return new Response(readFileSync(source));
      });
      const staged = join(temp, `staged-${gid}`);
      execFileSync(python, [validator, zip, "42", staged]);
      assert.equal(JSON.parse(readFileSync(join(staged, "42.json"))).depot["43"].manifests.public.gid, String(gid));
      const commit = publish("42", head, staged, join(temp, `index-${gid}`));
      assert.equal(git("ls-remote", "--heads", "origin", "42"), `${commit}\trefs/heads/42`);
      if (head) assert.equal(git("rev-parse", `${commit}^`), head);
      assert.deepEqual(git("ls-tree", "--name-only", commit).split("\n"), ["42.json", "42.lua", `43_${gid}.manifest`, "key.vdf"]);
      assert.equal(publish("42", commit, staged, join(temp, `same-${gid}`)), commit);
      head = commit;
    }
    const bad = join(temp, "unsafe.zip");
    execFileSync(python, ["-c", fixture, bad, "9", "unsafe"]);
    assert.throws(() => execFileSync(python, [validator, bad, "42", join(temp, "unsafe")], { stdio: "pipe" }));
    assert.equal(git("ls-remote", "--heads", "origin", "42"), `${head}\trefs/heads/42`);
  } finally {
    process.chdir(original);
    rmSync(temp, { recursive: true, force: true });
  }
});
