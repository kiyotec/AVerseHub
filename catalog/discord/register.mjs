const { DISCORD_APPLICATION_ID: app, DISCORD_GUILD_ID: guild, DISCORD_BOT_TOKEN: token } = process.env;
if (!/^\d{17,20}$/.test(app ?? "") || !/^\d{17,20}$/.test(guild ?? "") || !token) {
  console.error("Set DISCORD_APPLICATION_ID, DISCORD_GUILD_ID and DISCORD_BOT_TOKEN in the environment.");
  process.exitCode = 1;
} else {
  try {
    for (const [name, description, required] of [
      ["hub-sync", "Đồng bộ metadata Steam vào AVerseHub", false],
      ["hubget", "Lấy Lua và manifest cho một AppID", true],
      ["hubupdate", "Làm mới Lua và manifest của một AppID", true],
    ]) {
      const response = await fetch(`https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands`, {
        method: "POST",
        headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          type: 1, name, description, default_member_permissions: "8",
          options: [{ type: 4, name: "appid", description: "Steam AppID", required, min_value: 1, max_value: 0xffffffff }],
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
      console.log(`Registered /${name} in the selected Discord server.`);
    }
  } catch {
    console.error("Discord command registration failed. Check the app, server and bot token.");
    process.exitCode = 1;
  }
}
