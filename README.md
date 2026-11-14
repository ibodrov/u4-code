# U4 Code

U4 Code is a desktop and web app for the coding agents on your machines. It drives the agent CLIs you already use, such as Claude Code, Codex, Cursor, OpenCode and oh-my-pi, from one fast interface, and can run project workspaces on your own Kubernetes cluster.

> **Fork notice.** U4 Code is an independent fork of [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc. It is not affiliated with or endorsed by T3 Tools Inc. U4 Code is distributed under the [MIT License](./LICENSE), and the original T3 Tools Inc. copyright notice is retained. [U4.md](./U4.md) explains what differs from T3 Code and how the fork is maintained.

## What you get

- **Your subscriptions.** U4 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, any [ACP](./docs/user/providers-acp.md) agent, and the U4-only [oh-my-pi](./docs/user/providers-oh-my-pi.md) provider.
- **Desktop and web.** One server, and every client shows the same threads.
- **Remote ready.** Run agents on another machine and connect over your local network or Tailscale. See [remote access](./docs/user/remote-access.md).
- **Kubernetes workspaces.** Run a project in a retained workspace on your own cluster. See [U4 Kubernetes workspaces](./docs/user/remote-access.md#u4-kubernetes-workspaces).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request.
- **Side by side with T3 Code.** U4 Code keeps its own state, ports and URL schemes, so both apps can run on one account.

## Install

U4 Code has no published downloads, app store apps or hosted web app. Build it from source as described in [U4.md](./U4.md#build). Linux is the supported platform today.

The download links, mobile apps, hosted web app at app.t3.codes and Discord community of T3 Code belong to the upstream project, not to U4 Code. Report problems with U4 Code in this repository, not upstream.

## Privacy

U4 Code sends no usage analytics by default. The server sends product events only to an endpoint you set with `T3CODE_POSTHOG_KEY` and `T3CODE_POSTHOG_HOST`; see [product usage data](./docs/user/telemetry.md). Agents send your prompts to their providers under those providers' terms.

## Documentation

The documentation comes from T3 Code. Pages about T3 downloads, the mobile apps and T3 Connect describe upstream services that U4 Code does not provide.

- [Remote access from another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [oh-my-pi provider](./docs/user/providers-oh-my-pi.md)

[All docs](./docs/README.md) has the full list.

## Development

- [U4.md](./U4.md) covers building, installing, and rebasing the fork onto upstream releases.
- The [development runbook](./docs/operations/development.md#first-checkout) and the [architecture overview](./docs/internals/overview.md) come from T3 Code and also apply to U4 Code.
- Report problems that also happen in T3 Code upstream at [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

## License

U4 Code is distributed under the [MIT License](./LICENSE). The license file is unchanged from T3 Code and keeps its "Copyright (c) 2026 T3 Tools Inc." notice. The app lists T3 Code and third-party notices under **Settings → About → Open source licenses**.
