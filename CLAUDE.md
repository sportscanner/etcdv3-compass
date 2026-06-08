# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension ("Etcd Compass") that browses etcd v3 clusters from a sidebar
tree view. Connections are added via a webview form, persisted, and their
key-value pairs displayed as a navigable tree.

## Commands

- `npm run compile` — type-check and emit JS to `out/` (entry point is `out/extension.js`)
- `npm run watch` — incremental recompile on change
- `npm run package` — build a `.vsix` via `vsce package`
- Debug the extension: open in VS Code and press F5 (launches an Extension Development Host)

There is no test suite, linter, or formatter configured. `tsc` runs in `strict`
mode with `noUnusedLocals`/`noUnusedParameters`, so unused symbols fail the build.

Publishing is automated: pushing a `v*` git tag triggers `.github/workflows/publish.yml`,
which compiles, packages, and publishes to the VS Code Marketplace using the
`VSCE_PAT` secret. Bump `version` in `package.json` before tagging.

## Architecture

Three layers wired together in `src/extension.ts` (`activate`):

1. **`EtcdTreeDataProvider`** (`src/tree/EtcdTreeDataProvider.ts`) — the core. A
   `vscode.TreeDataProvider` that owns etcd clients, connection state, and all
   rendering. ~600 lines; most changes land here.
2. **`AddConnectionPanel`** (`src/panels/AddConnectionPanel.ts`) — a webview form
   for adding/editing a connection. Communicates back via `postMessage`
   (`save-connection`, `test-connection`). The same panel handles edit by being
   given a `prefill`.
3. **`EtcdDecorationProvider`** (`src/decorations/EtcdDecorationProvider.ts`) —
   tints connection labels by `colorTheme` even when selected, keyed by `etcd:<id>` URIs.

`EtcdConnection` (`src/types.ts`) is the persisted model. Connections are stored
in `context.globalState` under the key `etcdConnections` (`STATE_KEY`).

### Tree node model

`getChildren` returns one of: `ConnectionItem`, `FolderItem`, `KeyItem`,
`NoKeysItem`, `ErrorItem`. Each carries a `contextValue` (`etcd-connection`,
`etcd-folder`, `etcd-key`, etc.) that drives which context-menu commands appear
(see the `menus` block in `package.json`). When adding a command, register it in
both `package.json` (`commands` + `menus`) and `extension.ts`.

### Two view modes per connection

Each `ConnectionItem` has `isFlattened` and `isTreeView` flags toggled by
`etcdExplorer.toggleFlatten` / `toggleTreeView`. Tree mode lazily expands
folders by splitting keys on `/`; flat mode lists every key from `getAll()`.

### Caching & async loading

Children are loaded asynchronously and cached in `cachedChildren`, keyed by
`<connectionId>:flat`, `<connectionId>:tree`, or `<connectionId>:<prefix>`.
`getChildren` returns a `Loading...` placeholder immediately, kicks off the load,
then fires `onDidChangeTreeData` to re-render. After loading one view mode it
**preloads the other** so toggling is instant. When mutating keys, invalidate the
right cache entries — `refresh()` clears everything; `refreshConnection()` clears
only that connection's `flat`/`tree` keys; `refreshConnectionInstant()` clears
nothing (used for toggles that rely on preloaded data).

### etcd clients

`getClient` lazily creates and caches one `Etcd3` client per connection in
`clientsById`. Endpoints are stored as bare `host:port` (see `normalizeEndpoint`
in `extension.ts`, which strips schemes, maps `localhost`→`127.0.0.1`, defaults
port `2379`) because etcd3's grpc resolver wants bare hosts. Auth is set only
when both username and password are present.

Timeouts are per-connection (`connectionTimeoutMs`, `idleConnectionTimeoutMs`,
`operationTimeoutMs`), all defaulting to 5000ms. Note that operations wrap etcd3
calls in a manual `Promise.race` against a timeout because the library's own
timeout handling is unreliable here.

### Connection health

`startHealthChecks` polls every connection every 60s (throttled to one test per
connection per 30s) by issuing a get on the sentinel key `__test_connection_key__`.
Status (`connected`/`disconnected`/`unknown`) shows as `✓`/`✗`/`?` in the
`ConnectionItem` description. A stale client (failed test) is closed and recreated.
