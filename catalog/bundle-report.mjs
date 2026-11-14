import { readFileSync, writeFileSync } from "node:fs";
import { validAppId } from "./fetch-bundle.mjs";

const start = "<!-- hubcap-updates:start -->";
const end = "<!-- hubcap-updates:end -->";
const readme = new URL("../README.md", import.meta.url);
const time = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short",
});

function safeTitle(title) {
  if (typeof title !== "string" || !title.trim()) return "—";
  return title.trim().slice(0, 150).replace(/\s+/g, " ").replace(/[&<>|`*_[\]\\]/g, c => `&#${c.charCodeAt(0)};`);
}

export function describeChange(appId, previous, commit, git) {
  if (previous === commit) return null;
  const fileCounts = { A: 0, M: 0, D: 0 };
  const changes = git(["diff-tree", "--root", "--no-commit-id", "--no-renames", "-r", "--name-status", commit]);
  for (const line of changes.split("\n")) {
    const [status, name] = line.split("\t");
    if (name === `${appId}.lua` || name === `${appId}.json` || name === "key.vdf" || /^\d+_\d+\.manifest$/i.test(name ?? "")) {
      if (Object.hasOwn(fileCounts, status)) fileCounts[status]++;
    }
  }
  return { at: git(["show", "-s", "--format=%cI", commit]), action: previous ? "Cập nhật" : "Thêm mới", fileCounts, commit };
}

export function updatesTable(state) {
  const rows = Object.entries(state)
    .filter(([id, row]) => validAppId(id) && Number.isFinite(Date.parse(row.change?.at)) && /^[a-f0-9]{40}$/.test(row.change?.commit ?? ""))
    .sort((a, b) => Date.parse(b[1].change.at) - Date.parse(a[1].change.at))
    .slice(0, 15);
  if (!rows.length) return "Chưa ghi nhận bản cập nhật nào.";
  return [
    "| Giờ Việt Nam | AppID | Tên game | Thao tác | File thay đổi |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(([id, { change }]) => {
      const { A, M, D } = change.fileCounts;
      return `| ${time.format(new Date(change.at))} | [${id}](https://github.com/kiyotec/AVerseHub/tree/${id}) | ${safeTitle(change.title)} | ${change.action} | [${A} thêm, ${M} sửa, ${D} xóa](https://github.com/kiyotec/AVerseHub/commit/${change.commit}) |`;
    }),
  ].join("\n");
}

export function refreshReadme(state) {
  const current = readFileSync(readme, "utf8");
  const from = current.indexOf(start);
  const to = current.indexOf(end);
  if (from < 0 || to < from) throw new Error("README update markers are missing");
  const next = `${current.slice(0, from + start.length)}\n\n${updatesTable(state)}\n\n${current.slice(to)}`;
  if (next !== current) writeFileSync(readme, next, "utf8");
}
