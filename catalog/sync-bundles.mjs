import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchBundle, validAppId } from "./fetch-bundle.mjs";

const keywords = [
  "the", "game", "and", "edition", "demo", "playtest", "remastered", "complete",
  "full", "premium", "deluxe", "collection", "bundle", "ultimate", "standard", "pro",
];
const stateFile = new URL("./hubcap-revisions.json", import.meta.url);
const { HUBCAP_API_KEY, ...commandEnv } = process.env;
const key = HUBCAP_API_KEY?.trim();

function git(args, env = commandEnv) {
  return execFileSync("git", args, { env, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }).trim();
}

export function selectCandidates(rows, refs, state, now = Date.now()) {
  const unique = new Map();
  for (const row of rows) {
    const appId = String(row.game_id ?? "");
    const uploaded = Date.parse(row.uploaded_date);
    if (!validAppId(appId) || row.manifest_available !== true || !Number.isFinite(uploaded)) continue;
    if (uploaded > (unique.get(appId) ?? 0)) unique.set(appId, uploaded);
  }
  return [...unique].filter(([id, uploaded]) => {
    if (state[id]?.uploaded >= uploaded && state[id]?.commit === refs.get(id)) return false;
    return !refs.has(id) || state[id] || uploaded >= now - 14 * 86400_000;
  }).sort((a, b) => b[1] - a[1]);
}

export async function discover(apiKey, request = fetch, now = Date.now(), pause = delay) {
  const perRun = 4;
  const start = Math.floor(now / 86_400_000) * perRun % keywords.length;
  const rows = [];
  for (const keyword of keywords.slice(start, start + perRun)) {
    const url = new URL("https://hubcapmanifest.com/api/v1/search");
    url.search = new URLSearchParams({ q: keyword, limit: "100" });
    const options = {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      redirect: "error",
    };
    if (keyword !== keywords[start]) await pause(2_000);
    let response = await request(url, { ...options, signal: AbortSignal.timeout(20_000) });
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 429 && /^[0-9]{1,2}$/.test(retryAfter ?? "") && Number(retryAfter) <= 30) {
      await response.body?.cancel();
      await pause(Math.max(2, Number(retryAfter)) * 1_000);
      response = await request(url, { ...options, signal: AbortSignal.timeout(20_000) });
    }
    if (!response.ok) {
      await response.body?.cancel();
      const hint = [401, 403].includes(response.status) ? ". Check whether HUBCAP_API_KEY has expired" : "";
      const message = `Hubcap search for ${keyword} returned HTTP ${response.status}${hint}`;
      if (response.status !== 429 || keyword === keywords[start]) throw new Error(message);
      console.warn(`${message}; processing search results already received.`);
      break;
    }
    const result = await response.json();
    if (!Array.isArray(result.results)) throw new Error("Hubcap search response has an unexpected format");
    rows.push(...result.results);
    console.log(`Hubcap search for ${keyword}: ${result.results.length} result(s)`);
  }
  return rows;
}

export function publish(appId, oldHead, files, gitIndex, remote = "origin", push = true) {
  if (!validAppId(appId)) throw new Error("Invalid AppID");
  const env = { ...commandEnv, GIT_INDEX_FILE: gitIndex };
  const branch = `refs/heads/${appId}`;
  if (oldHead) {
    git(["fetch", "--no-tags", "--depth=1", remote, branch]);
    if (git(["rev-parse", "FETCH_HEAD"]) !== oldHead) throw new Error("AppID branch changed during sync");
    git(["read-tree", oldHead], env);
  }
  const staged = new Set(readdirSync(files));
  for (const name of staged) {
    if (name !== `${appId}.lua` && name !== `${appId}.json` && name !== "key.vdf" && !/^[0-9]+_[0-9]+\.manifest$/.test(name))
      throw new Error("Unexpected staged bundle file");
  }
  const existing = oldHead ? git(["ls-tree", "--name-only", oldHead]).split("\n") : [];
  for (const name of existing) {
    if (/^[0-9]+_[0-9]+\.manifest$/i.test(name) && !staged.has(name)) {
      git(["update-index", "--force-remove", "--", name], env);
    }
  }
  for (const name of staged) {
    const blob = git(["hash-object", "-w", "--no-filters", "--", join(files, name)]);
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${name}`], env);
  }
  const tree = git(["write-tree"], env);
  if (oldHead && tree === git(["rev-parse", `${oldHead}^{tree}`])) return oldHead;
  const parent = oldHead ? ["-p", oldHead] : [];
  const commit = git([
    "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit-tree", tree, ...parent, "-m", `Sync AppID ${appId} from Hubcap`,
  ], env);
  if (push) git(["push", remote, `${commit}:${branch}`]);
  return commit;
}

async function main() {
  const requested = process.argv[2];
  if (process.argv.length > 3 || (requested !== undefined && !validAppId(requested))) throw new Error("Invalid AppID");
  if (!key) throw new Error("Set HUBCAP_API_KEY in AVerseHub Actions secrets");
  const limit = Number(process.env.HUBCAP_SYNC_LIMIT || 5);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("HUBCAP_SYNC_LIMIT must be 1–100");

  const refs = new Map(git(["ls-remote", "--heads", "origin"]).split("\n").flatMap(line => {
    const match = /^([0-9a-f]{40})\s+refs\/heads\/([0-9]+)$/.exec(line);
    return match ? [[match[2], match[1]]] : [];
  }));
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
  const pending = requested ? [[requested, state[requested]?.uploaded ?? 0]] : selectCandidates(await discover(key), refs, state).slice(0, limit);
  console.log(`${pending.length} AppID(s) selected`);
  let failed = 0;
  for (const [appId, uploaded] of pending) {
    const temp = mkdtempSync(join(tmpdir(), "aversehub-bundle-"));
    try {
      const archive = await fetchBundle(appId, temp, key);
      const files = join(temp, "files");
      execFileSync(process.env.PYTHON || "python", [fileURLToPath(new URL("./validate-bundle.py", import.meta.url)), archive, appId, files],
        { env: commandEnv, stdio: "inherit", timeout: 60_000 });
      const commit = publish(appId, refs.get(appId), files, join(temp, "index"));
      state[appId] = { uploaded, commit };
      const ordered = Object.fromEntries(Object.entries(state).sort(([a], [b]) => Number(a) - Number(b)));
      writeFileSync(stateFile, JSON.stringify(ordered, null, 2) + "\n", "utf8");
      console.log(`AppID ${appId}: ${commit}`);
    } catch (error) {
      console.error(`AppID ${appId}: ${error.message}`);
      failed++;
      if ([401, 403, 429].includes(error.status)) break;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
