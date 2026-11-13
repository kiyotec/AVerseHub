import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const upstream = "https://github.com/DrxmReal/WhoziaoHub.git";
const index = new URL("./appid-revisions.tsv", import.meta.url);
const temp = new URL("./appid-revisions.tsv.tmp", import.meta.url);
const refs = execFileSync("git", ["ls-remote", "--heads", upstream], {
  encoding: "utf8",
  timeout: 120_000,
  maxBuffer: 16 * 1024 * 1024,
});

const revisions = new Map();
for (const line of refs.split(/\r?\n/)) {
  const match = /^([0-9a-f]{40})\trefs\/heads\/([1-9][0-9]*)$/.exec(line);
  if (!match) continue;
  const appId = Number(match[2]);
  if (appId > 0xffffffff) throw new Error("AppID outside the Steam uint32 range");
  revisions.set(appId, match[1]);
}

const previous = existsSync(index) ? readFileSync(index, "utf8") : "";
const previousCount = previous.split("\n").filter(line => /^[0-9]+\t/.test(line)).length;
if (revisions.size < 1000 || revisions.size < previousCount * 0.9) {
  throw new Error("Upstream returned an unexpectedly small AppID index");
}

const rows = [...revisions].sort(([first], [second]) => first - second);
const content = "app_id\tupstream_commit\n" + rows.map(row => row.join("\t")).join("\n") + "\n";
if (previous !== content) {
  writeFileSync(temp, content, "utf8");
  renameSync(temp, index);
}
console.log(`${revisions.size} AppIDs (${previous === content ? "unchanged" : "index updated"})`);
