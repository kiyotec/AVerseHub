import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";

const [appId, outputDirectory] = process.argv.slice(2);
const key = process.env.HUBCAP_API_KEY?.trim();
const limit = 64 * 1024 * 1024;

async function main() {
  if (process.argv.length !== 4 || !/^[1-9][0-9]{0,9}$/.test(appId ?? "") || Number(appId) > 0xffffffff)
    throw new Error("Usage: node catalog/fetch-bundle.mjs <AppID> <local-output-directory>");
  if (!key) throw new Error("Set HUBCAP_API_KEY in your local environment.");

  const source = new URL(`https://hubcapmanifest.com/api/v1/manifest/${appId}`);
  source.searchParams.set("api_key", key);
  let response;
  try { response = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(90_000) }); }
  catch { throw new Error("Could not connect to Hubcap."); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Hubcap returned HTTP ${response.status}.`);
  }
  if (!response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Hubcap response is missing or larger than 64 MiB.");
  }

  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${appId}.zip`);
  const temp = join(directory, `.${appId}-${crypto.randomUUID()}.tmp`);
  let size = 0;
  let prefix = Buffer.alloc(0);
  const verify = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > limit) return callback(new Error("Bundle exceeds 64 MiB."));
      if (prefix.length < 4) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, 4 - prefix.length)]);
        if (prefix.length === 4 && !prefix.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
          return callback(new Error("Hubcap response is not a ZIP."));
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(temp, { flags: "wx" }));
    if (size < 22) throw new Error("Hubcap returned an incomplete ZIP.");
    await rename(temp, target);
    console.log(`Saved bundle locally to ${target}`);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
