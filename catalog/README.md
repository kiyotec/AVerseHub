# AVerseHub catalog

[`appid-revisions.tsv`](appid-revisions.tsv) lists numeric branch names and their head commits from [WhoziaoHub](https://github.com/DrxmReal/WhoziaoHub). Each line records that the upstream advertised a branch. Steam controls game access and installation.

The [sync workflow](../.github/workflows/catalog-sync.yml) runs daily at 02:23 UTC and supports manual dispatch. It reads Git refs, sorts by AppID, and commits changes to the TSV on `main`. Existing branches and payloads are outside this workflow.

WhoziaoHub's historical uploader searched Hubcap by keyword, sorted candidates by upload time, and compared AppIDs against existing GitHub branches. An older README describes Discord commands for adding and refreshing an AppID. The public README workflow looks up Steam Store titles after branch pushes. The uploader files were later removed from the branch where they were found. [Historical uploader](https://github.com/DrxmReal/WhoziaoHub/commit/589fa5d949e2) · [Old README](https://github.com/SSMG64/ManifestHub2/commit/2df23bb40dd0c0d8679ccf31b79d2943af442a03) · [Cleanup](https://github.com/DrxmReal/WhoziaoHub/commit/a4472773bf24)

## Independent Steam catalog

The [Steam Store workflow](../.github/workflows/steam-catalog.yml) writes [steam-apps.json](steam-apps.json) on `main`. Enter an AppID under **Run workflow** to look up that entry immediately. This uses the public Store endpoint. To enable the full daily sync at 02:41 UTC, add `STEAM_WEB_API_KEY` as an Actions repository secret. The full sync uses Steamworks pagination and an incremental cursor. The file contains public metadata. [Steamworks documentation](https://partner.steamgames.com/doc/webapi/IStoreService#GetAppList)

## Discord

`/hubget appid:<id>` and `/hubupdate appid:<id>` start the Hubcap bundle workflow. `/hub-sync [appid]` starts the Steam Store workflow. Commands require Administrator permission on the configured Discord server and reply privately with a GitHub Actions link.

1. Create and install a Discord application in your server. Copy its application ID, public key and server ID. [Discord setup](https://docs.discord.com/developers/quick-start/getting-started)
2. Deploy `catalog/discord/wrangler.jsonc` to a Cloudflare Worker. Set `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY` and `DISCORD_GUILD_ID`. Set `GITHUB_ACTIONS_TOKEN` as a Worker secret using a fine-grained token scoped to AVerseHub with Actions write permission.
3. Set the Discord interaction endpoint to the Worker URL followed by `/interactions`. Run `node catalog/discord/register.mjs` with `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID` and `DISCORD_BOT_TOKEN` in your local environment.

## Optional local bundle download

For data you are authorized to retrieve, set your own `HUBCAP_API_KEY` locally and run `node catalog/fetch-bundle.mjs <AppID> <local-output-directory>`. Choose an output directory outside the Git checkout. It stores the ZIP for inspection. The command does not extract, upload or install the archive. The catalog workflow uses Steam, so it does not consume Hubcap quota. [HubcapDB](https://hubcapmanifest.com/) · [API use in LuaTools](https://github.com/madoiscool/LuaTools/blob/main/src/LuaToolsGui/Services/HubcapService.cs)

## Automatic Lua and manifest sync

1. Add `HUBCAP_API_KEY` as an [Actions repository secret](https://github.com/kiyotec/AVerseHub/settings/secrets/actions). Use a Hubcap account whose permissions cover the data you intend to publish in this public repository.
2. Run [Sync Hubcap game bundles](https://github.com/kiyotec/AVerseHub/actions/workflows/hubcap-bundles.yml) with an AppID to fetch it now. Leave the field blank to look for recent Hubcap uploads.
3. The job validates the ZIP, parses the AppID Lua as data, and checks the depot and manifest IDs. It publishes `<AppID>.lua`, `<AppID>.json`, `key.vdf` and the referenced `.manifest` files in the branch named by AppID. The same command creates a missing branch or makes a fast-forward update. An identical tree adds no commit.

The job is scheduled at 03:17 UTC. It rotates through four Hubcap search keywords per day and spaces requests to respect rate limits. The default is five downloads per run, configurable with the repository variable `HUBCAP_SYNC_LIMIT`. `hubcap-revisions.json` records successful updates so the same search result is skipped on subsequent runs. Steam Web API credentials are used only by the separate Steam Store workflow.

If your Hubcap API key expires, generate a new key on the Hubcap account page and update the existing `HUBCAP_API_KEY` repository secret. You can start the workflow again immediately after saving it.
