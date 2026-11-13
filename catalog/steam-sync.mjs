import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const catalogFile = new URL("./steam-apps.json", import.meta.url);
const maxAppId = 0xffffffff;
const validId = value => Number.isInteger(value) && value > 0 && value <= maxAppId;
const cleanName = value => typeof value === "string" && value.trim().length <= 500 ? value.trim() : "";

async function requestJson(url, headers, label) {
  let response;
  try {
    response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(25_000) });
  } catch {
    throw new Error(`${label} is unreachable`);
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  try { return await response.json(); }
  catch { throw new Error(`${label} returned invalid JSON`); }
}

export async function fetchSteamApps(key, previous, request = requestJson, now = Math.floor(Date.now() / 1000)) {
  if (!key?.trim()) throw new Error("Set STEAM_WEB_API_KEY to sync the full Steam catalog");
  const apps = new Map(previous.apps.map(app => [app.appId, app]));
  // Overlap the previous run so entries changed while pages were read are seen again.
  const since = Math.max(0, previous.cursor - 3600);
  let after = 0;
  for (let page = 0; page < 100; page++) {
    const url = new URL("https://api.steampowered.com/IStoreService/GetAppList/v1/");
    url.searchParams.set("input_json", JSON.stringify({
      include_games: true, include_dlc: true, max_results: 10000,
      ...(since && { if_modified_since: since }), ...(after && { last_appid: after }),
    }));
    const { response } = await request(url, { "x-webapi-key": key.trim() }, "Steam GetAppList");
    if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Invalid Steam catalog response");
    if (response.have_more_results !== undefined && typeof response.have_more_results !== "boolean")
      throw new Error("Invalid Steam pagination flag");
    const rows = response.apps ?? [];
    if (!Array.isArray(rows) || (previous.cursor === 0 && page === 0 && rows.length === 0))
      throw new Error("Steam returned an empty or invalid initial catalog");

    let last = after;
    for (const row of rows) {
      if (!validId(row?.appid) || row.appid <= last) throw new Error("Invalid or out-of-order Steam AppID");
      last = row.appid;
      const name = cleanName(row.name);
      if (!name) continue;
      apps.set(row.appid, { ...apps.get(row.appid), appId: row.appid, name, lastModified: Number.isInteger(row.last_modified) ? row.last_modified : 0 });
    }
    if (!response.have_more_results) return { cursor: Math.max(now, previous.cursor), apps: [...apps.values()].sort((a, b) => a.appId - b.appId) };
    if (last === after || response.last_appid !== last) throw new Error("Steam catalog cursor did not advance");
    after = last;
  }
  throw new Error("Steam catalog exceeded the pagination limit");
}

export async function fetchSteamApp(appId, request = requestJson) {
  if (!validId(appId)) throw new Error("AppID must be a positive uint32");
  const url = new URL("https://store.steampowered.com/api/appdetails");
  url.search = new URLSearchParams({ appids: String(appId), filters: "basic", l: "english" });
  const result = (await request(url, { "user-agent": "AVerseHub-Catalog/1.0" }, "Steam Store appdetails"))?.[appId];
  const data = result?.data;
  const name = cleanName(data?.name);
  if (!result?.success || data?.steam_appid !== appId || !name || typeof data.type !== "string")
    throw new Error("Steam Store has no matching public entry for this AppID");
  return { appId, name, type: data.type };
}

async function main() {
  const input = process.argv[2];
  if (process.argv.length > 3 || (input !== undefined && !/^[1-9][0-9]{0,9}$/.test(input)))
    throw new Error("Usage: node catalog/steam-sync.mjs [AppID]");
  const previous = existsSync(catalogFile) ? JSON.parse(readFileSync(catalogFile, "utf8")) : { cursor: 0, apps: [] };
  let next;
  if (input === undefined) {
    next = await fetchSteamApps(process.env.STEAM_WEB_API_KEY, previous);
  } else {
    const app = await fetchSteamApp(Number(input));
    const apps = new Map(previous.apps.map(row => [row.appId, row]));
    apps.set(app.appId, { ...apps.get(app.appId), ...app });
    next = { ...previous, apps: [...apps.values()].sort((a, b) => a.appId - b.appId) };
  }
  if (JSON.stringify(next) === JSON.stringify(previous)) {
    console.log("Steam catalog unchanged");
    return;
  }
  const temp = new URL("./steam-apps.json.tmp", import.meta.url);
  writeFileSync(temp, `{\n  "cursor": ${next.cursor},\n  "apps": [\n${next.apps.map(row => "    " + JSON.stringify(row)).join(",\n")}\n  ]\n}\n`);
  renameSync(temp, catalogFile);
  console.log(`${next.apps.length} Steam Store entries saved`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
