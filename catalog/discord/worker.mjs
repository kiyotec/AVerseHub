const repository = "kiyotec/AVerseHub";
const bundleWorkflow = "hubcap-bundles.yml";
const workflows = { "hub-sync": "steam-catalog.yml", hubget: bundleWorkflow, hubupdate: bundleWorkflow, hubscan: bundleWorkflow };
const encoder = new TextEncoder();
const noMentions = { parse: [] };
const hexBytes = hex => Uint8Array.from(hex.match(/../g), pair => Number.parseInt(pair, 16));
const privateReply = content => Response.json({ type: 4, data: { content, flags: 64, allowed_mentions: noMentions } });

async function isSigned(request, rawBody, publicKey) {
  const stamp = request.headers.get("x-signature-timestamp") ?? "";
  const signature = request.headers.get("x-signature-ed25519") ?? "";
  if (!/^[0-9]{1,12}$/.test(stamp) || !/^[a-f0-9]{128}$/i.test(signature)
      || Math.abs(Date.now() / 1000 - Number(stamp)) > 300) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexBytes(publicKey), "Ed25519", false, ["verify"]);
    const timestamp = encoder.encode(stamp);
    const message = new Uint8Array(timestamp.length + rawBody.length);
    message.set(timestamp);
    message.set(rawBody, timestamp.length);
    return await crypto.subtle.verify("Ed25519", key, hexBytes(signature), message);
  } catch {
    return false;
  }
}

async function readBody(request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const result = new Uint8Array(32 * 1024);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return result.subarray(0, length);
      if (length + value.length > result.length) {
        await reader.cancel();
        return null;
      }
      result.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

function github(path, env, request, body) {
  return request(`https://api.github.com/repos/${repository}/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(env.GITHUB_ACTIONS_TOKEN ? { authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}` } : {}),
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "AVerseHub-Discord",
      "x-github-api-version": "2026-03-10",
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

async function dispatch(env, appId, workflow, request) {
  let message = "GitHub chưa nhận được yêu cầu đồng bộ.";
  try {
    const response = await github(`actions/workflows/${workflow}/dispatches`, env, request, { ref: "main", inputs: { app_id: appId } });
    if (response.ok) {
      const result = response.status === 200 ? await response.json() : {};
      const url = Number.isSafeInteger(result.workflow_run_id)
        ? `https://github.com/${repository}/actions/runs/${result.workflow_run_id}`
        : `https://github.com/${repository}/actions/workflows/${workflow}`;
      const subject = workflow === bundleWorkflow ? "gói Lua và manifest" : "danh mục Steam";
      message = `Đã yêu cầu đồng bộ ${subject}${appId ? ` cho AppID ${appId}` : ""}. [Xem lượt chạy](${url}).`;
    }
  } catch {
    // Report a generic failure without logging tokens or upstream response bodies.
  }
  return message;
}

async function status(env, appId, request) {
  try {
    if (appId) {
      const response = await github(`contents?ref=${appId}`, env, request);
      if (response.status === 404) return `Chưa có nhánh AppID ${appId} trên AVerseHub.`;
      if (!response.ok) throw new Error();
      const entries = await response.json();
      const files = entries.filter(entry => entry.type === "file").map(entry => entry.name);
      const manifestCount = files.filter(name => /^\d+_\d+\.manifest$/i.test(name)).length;
      const lua = files.includes(`${appId}.lua`) ? "có Lua" : "thiếu Lua";
      return `AppID ${appId} · ${lua} · ${manifestCount} manifest. [Xem nhánh](https://github.com/${repository}/tree/${appId}).`;
    }
    const response = await github(`actions/workflows/${bundleWorkflow}/runs?branch=main&per_page=1`, env, request);
    if (!response.ok) throw new Error();
    const { workflow_runs: [run] } = await response.json();
    if (!run) return "Chưa tìm thấy lượt đồng bộ trên GitHub Actions.";
    const labels = { success: "thành công", failure: "lỗi", in_progress: "đang chạy", queued: "đang chờ", cancelled: "đã hủy" };
    const label = labels[run.conclusion ?? run.status] ?? "xem trên GitHub";
    return `Lượt đồng bộ gần nhất #${run.run_number} · ${label}. [Xem lượt chạy](https://github.com/${repository}/actions/runs/${run.id}).`;
  } catch {
    return "Chưa đọc được trạng thái từ GitHub.";
  }
}

async function finish(interaction, message, request) {
  await request(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: await message, allowed_mentions: noMentions }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

export async function handleInteraction(request, env, context, outbound = fetch) {
  if (new URL(request.url).pathname !== "/interactions" || request.method !== "POST") return new Response(null, { status: 404 });
  if (!/^[a-f0-9]{64}$/i.test(env.DISCORD_PUBLIC_KEY ?? "")) return new Response(null, { status: 503 });
  const raw = await readBody(request);
  if (!raw) return new Response(null, { status: 413 });
  if (!await isSigned(request, raw, env.DISCORD_PUBLIC_KEY)) return new Response(null, { status: 401 });

  let data;
  try { data = JSON.parse(new TextDecoder().decode(raw)); }
  catch { return new Response(null, { status: 400 }); }
  if (!data || data.application_id !== env.DISCORD_APPLICATION_ID) return new Response(null, { status: 401 });
  if (data.type === 1) return Response.json({ type: 1 });
  const command = data.data?.name;
  if (data.type !== 2 || (command !== "hubstatus" && !Object.hasOwn(workflows, command))) return privateReply("Lệnh không được hỗ trợ.");
  const permissions = data.member?.permissions ?? "";
  if (!env.DISCORD_GUILD_ID || data.guild_id !== env.DISCORD_GUILD_ID || !/^[0-9]{1,24}$/.test(permissions)
      || (BigInt(permissions) & 8n) === 0n) return privateReply("Lệnh này dành cho quản trị viên của máy chủ AVerseHub.");
  const appId = String(data.data.options?.find(option => option.name === "appid")?.value ?? "");
  if ((appId !== "" || ["hubget", "hubupdate"].includes(command)) && (!/^[1-9][0-9]{0,9}$/.test(appId) || Number(appId) > 0xffffffff))
    return privateReply("Nhập AppID Steam hợp lệ.");
  if ((command !== "hubstatus" && !env.GITHUB_ACTIONS_TOKEN) || typeof data.token !== "string" || !/^[\w.-]{1,512}$/.test(data.token))
    return privateReply("Bot chưa được cấu hình đầy đủ.");

  const reply = command === "hubstatus" ? status(env, appId, outbound) : dispatch(env, appId, workflows[command], outbound);
  context.waitUntil(finish(data, reply, outbound).catch(() => {}));
  return Response.json({ type: 5, data: { flags: 64 } });
}

export default { fetch: (request, env, context) => handleInteraction(request, env, context) };
