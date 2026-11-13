# AppID index

[`appid-revisions.tsv`](appid-revisions.tsv) lists numeric branch names and their head commits from [WhoziaoHub](https://github.com/DrxmReal/WhoziaoHub). Each line records that the upstream advertised a branch. Steam controls game access and installation.

The [sync workflow](../.github/workflows/catalog-sync.yml) runs daily at 02:23 UTC and supports manual dispatch. It reads Git refs, sorts by AppID, and commits changes to the TSV on `main`. Existing branches and payloads are outside this workflow.

WhoziaoHub describes a Discord bot that updates its game branches. Its public workflow runs after branch pushes and looks up titles from Steam Store for the README. The published workflow and repository tree do not identify the bot's discovery or intake service. [WhoziaoHub README](https://github.com/DrxmReal/WhoziaoHub#readme) · [Upstream workflow](https://github.com/DrxmReal/WhoziaoHub/blob/main/.github/workflows/auto_readme.yml)

For independent discovery of Steam Store listings, Valve documents `IStoreService/GetAppList` with `last_appid` for pagination and `if_modified_since` for incremental refresh. The endpoint requires a Steam Web API key. [Steamworks documentation](https://partner.steamgames.com/doc/webapi/IStoreService#GetAppList)
