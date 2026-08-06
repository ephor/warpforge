# 005 — Hot-swap agent accounts (Codex + Claude)

Priority: P2 · Effort: L · Depends on: — · Status: IN PROGRESS (phases 1–4 done)

Let a user register several Codex (and Claude Code) accounts, see each one's
usage/limit, and switch which account new agent sessions use — one click, no
re-login, no config editing. Takes Orca's UX (`docs/agents/codex-hot-swap`: one
switcher chip in the status bar) and t3code's on-disk mechanism (shadow homes),
which is stronger than Orca's credential-pointer rewrite: the account is scoped
to the spawned process, so two tasks can run on two accounts at once and the
user's terminal `codex` is never touched.

## Verified facts (probed 2026-07-27, this machine)

- `codex-cli 0.144.6` honors `CODEX_HOME`; it *errors* if the dir does not
  exist, so Warpforge must create the profile dir before spawning.
- `/opt/homebrew/bin/codex-acp` is a node script that spawns `codex app-server`
  with `env` derived from `process.env` → `CODEX_HOME` propagates through the
  ACP wrapper. No patch to codex-acp needed.
- `~/.codex/auth.json` shape: `{ auth_mode, OPENAI_API_KEY, tokens: { id_token,
  access_token, refresh_token, account_id }, last_refresh }`.
- `tokens.id_token` is a JWT; its payload carries `email`, `name`, and
  `https://api.openai.com/auth` → `{ chatgpt_account_id, chatgpt_plan_type }`.
  Enough to label an account without any network call.
- Rate limits are already on disk: `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`
  contains `"rate_limits":{"limit_id":"codex","primary":{"used_percent":33.0,
  "window_minutes":10080,"resets_at":<unix>},"secondary":…,"credits":{…}}`.
- `claude 2.1.221` scopes macOS Keychain credentials per config dir
  (`Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[..8]>`); three such scoped
  items already exist in this machine's login keychain alongside the canonical
  one. Credentials also land at `<configDir>/.credentials.json`.
- `codex-acp` **swallows** the `account/rateLimits/updated` notification into its
  internal `sessionState.rateLimits` and returns `null` — it is *not* forwarded
  over ACP. It surfaces only as markdown text from the `/status` command
  (`buildStatusMessage` → `formatRateLimitLines`). So live limits are reachable
  over ACP, but only by asking; there is no push channel.
- Rollout `session_meta` carries `session_id, cwd, originator, cli_version,
  model_provider, git…` — **no account id**. Usage read from a shared sessions
  dir cannot be attributed to an account by the file alone.
- Claude Code honors `CLAUDE_CONFIG_DIR` (string present in the binary), but on
  macOS its credentials live in the login Keychain under service
  `Claude Code-credentials` (verified present; `~/.claude/.credentials.json`
  absent). Account metadata is in `~/.claude.json` → `oauthAccount`
  (`emailAddress`, `organizationName`, `seatTier`, …).
- Spawn path today: `actor.rs:3268` resolves the command, `acp.rs:469` runs
  `sh -c <command>` with **no env customization**. That is the single seam.

## Prior art

### Orca — `ref-projects/orca` (the feature this plan copies)

The real implementation, cloned from `github.com/stablyai/orca`. Read these
first; everything below is derived from them:

- `src/main/codex-accounts/runtime-home-service.ts` (2410 lines) — the whole
  account-switch contract: per-account `CODEX_HOME`, login, quota paths.
- `src/main/codex/codex-home-paths.ts` — managed home location + how system
  `~/.codex` resources are linked in. Its comment states the invariant:
  *"a per-account launch home is complete without ever symlinking into or
  mutating the user's real ~/.codex"*.
- `src/main/codex-accounts/runtime-selection.ts` — active account is stored
  **per runtime target** (host, each WSL distro), not globally.
- `src/main/claude-accounts/keychain.ts` — Claude credential scoping (see the
  correction below).
- `src/main/claude-accounts/environment.ts` — auth env vars that must be
  stripped, or they silently override the selected account.
- `src/main/providers/local-pty-shell-ready.ts:131` — `CODEX_HOME` is re-exported
  from `ORCA_CODEX_HOME` *after* profile/rc files run, because rc files clobber it.
- `src/main/rate-limits/codex-fetcher.ts`, `claude-fetcher.ts` — how usage is
  actually fetched (not by scraping rollouts).

Orca's shape: managed homes live in its own userData
(`~/Library/Application Support/orca/codex-runtime-home/home`), one per account,
self-contained; `~/.codex` is read-only input. Sessions are bridged/backfilled
between system and managed homes (`codex-account-session-bridge.ts`) rather than
symlinked.

### t3code — `ref-projects/t3code` (mechanism only, no switcher)

t3code ships the *on-disk mechanism*, **not** the hot-swap UX: you register one
provider instance per account, each with its own `shadowHomePath`, and switch by
picking a different provider in the model picker. `switchAccount|accountSwitcher|
swapAccount` has zero hits across `apps/` and `packages/`. Its value here is the
shadow-home layout and its guard tests:

- `apps/server/src/provider/Drivers/CodexHomeLayout.ts` — the shadow-home
  materializer (symlink policy, private entries, conflict errors).
- `apps/server/src/provider/Drivers/CodexHomeLayout.test.ts` — the behaviors
  worth porting as our test list.
- `apps/server/src/provider/Drivers/ClaudeHome.ts` — why `CLAUDE_CONFIG_DIR`
  and *not* `HOME`.
- `docs/providers/codex.md` — the user-facing model ("work" + "personal" homes).
- `packages/contracts/src/settings.ts:198-220` — `homePath` + `shadowHomePath`
  as plain per-provider settings.

### Correction to an earlier assumption in this plan

`ClaudeHome.ts:27-32` (t3code) says `CLAUDE_CONFIG_DIR` leaves the login keychain
intact, which read as "Claude credentials can't be isolated per config dir".
That is **no longer true**, and Orca's code says why
(`src/main/claude-accounts/keychain.ts:88-92`):

> Claude Code 2.1+ scopes macOS Keychain credentials by config dir using the
> first 8 hex chars of sha256(CLAUDE_CONFIG_DIR).

Verified on this machine: `claude 2.1.221`, and the login keychain already holds
`Claude Code-credentials` plus three scoped items
(`Claude Code-credentials-7b024401`, `-994d795c`, `-f4378456`). So Claude account
isolation via `CLAUDE_CONFIG_DIR` *is* possible — **no login spike is needed to
find out**. Phase 3 still swaps credentials rather than splitting config dirs,
but for a product reason (fragmenting skills/plugins/history), not because
isolation is impossible. The scoped-keychain fact matters there too: an activate
must write both the canonical and the config-dir-scoped item.

## Design decision: one mechanism per agent

The two agents are not symmetrical, and forcing one mechanism on both is the
mistake to avoid. Orca — which ships this feature — uses a different mechanism
for each, and so should we.

**Codex → per-account home + env at spawn (mechanism A).**
`~/.warpforge/accounts/codex/<slug>/` becomes `CODEX_HOME` for that account, with
the shared `~/.codex` linked in for everything that is not account-specific.
Switching = choosing which env map the next `spawn_acp_session` gets. Chosen
because Codex refreshes its OAuth token and writes `auth.json` back: under a
pointer swap the refresh lands in the shared file and the stored copy goes stale
(silent "logged out again"), while under A each home refreshes its own. It also
never touches the user's terminal `codex`, and it permits per-task accounts.

**Claude → credential vault + swap on activate (mechanism B).**
Claude 2.1+ *can* be isolated by `CLAUDE_CONFIG_DIR` (it scopes keychain items by
`sha256(configDir)`), but the config dir also holds skills, plugins, settings,
MCP config, and project history — one dir per account fragments all of it. Orca
isolates by config dir only on WSL (`runtime-auth-service.ts:292`) and on the
host materializes the selected account's credentials into the live config dir
(`:426,550`). Same call here: keep one config dir, keep per-account credentials
in our vault, swap on activate. The cost is that the swap is global — the user's
terminal `claude` follows it too — which is exactly what Orca documents.

Consequence to hold onto: **Codex gets per-task accounts, Claude does not.**

### Codex home layout (port of `CodexHomeLayout.ts`)

Shared home = `~/.codex` (or a configured override). For each account slug:

| Entry | Treatment | Why |
|---|---|---|
| `auth.json` | **real file, per-account** | the account itself; must never be a symlink |
| `models_cache.json` | **real file, per-account** | model list depends on the account's plan |
| `log`, `memories`, `tmp` | shadow-local, not linked | noisy per-process state |
| `sessions`, `archived_sessions`, `sqlite`, `shell_snapshots`, `worktrees`, `skills`, `plugins`, `cache`, `logs`, `mcp-oauth-locks` | symlink → shared | both accounts see one thread history; a thread can continue under either account |
| everything else present in shared home (`config.toml`, `AGENTS.md`, `prompts/`, …) | symlink → shared | one config, edited in one place |

Two invariants both reference implementations enforce, and we must too:
**never create or modify anything inside the user's real `~/.codex`** — it is a
read-only input, and every link lives inside our account home; and **mark every
entry we materialize as ours** (Orca's "ownership markers",
`codex-home-paths.ts:73`) so removing an account cleans up exactly what we made
and nothing else.

Materialize on every activation (idempotent), not once at import: the shared
home grows new entries over time. Port t3code's four guards — shadow path must
differ from shared, `auth.json` in the shadow must not be a symlink, a
non-symlink collision is an error (except replaceable runtime dirs like
`mcp-oauth-locks`), and a symlink pointing at the wrong target is relinked.

Consequence of shared `sessions`: rollouts from all accounts land in one dir and
carry no account id, so usage attribution needs Warpforge's own
session_id → task → account mapping (see Phase 3). This is the price of shared
thread history, and it is worth paying — a per-account `sessions` dir would mean
a thread started on "work" is invisible after switching to "personal".

Claude Code cannot use A cleanly on macOS (single global Keychain item). Plan
its credential handling as B-with-per-profile-Keychain-items (see Phase 5) and
gate it behind a spike.

## Data model

`~/.warpforge/accounts/<agent_id>/<slug>/` — profile home (0700).

SQLite (`store.rs`, additive `CREATE TABLE IF NOT EXISTS` like the existing
migrations):

```sql
CREATE TABLE IF NOT EXISTS agent_accounts (
    id         TEXT PRIMARY KEY,   -- "codex:personal"
    agent_id   TEXT NOT NULL,      -- "codex" | "claude"
    label      TEXT NOT NULL,      -- user-facing, editable
    email      TEXT,               -- from id_token / oauthAccount
    plan       TEXT,               -- chatgpt_plan_type / seatTier
    home_dir   TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS active_account (
    agent_id   TEXT PRIMARY KEY,
    account_id TEXT NOT NULL
);
```

Plus `ALTER TABLE tasks ADD COLUMN account_id TEXT` — records which account a
task's session was started with, so resume/restart reuses it (Orca's "the
restart chip preserves the active account at the time of restart").

**No secret ever leaves the daemon.** `auth.json` contents, access/refresh
tokens, and Keychain blobs are never put in protocol messages, events, or logs.
The frontend sees id, label, email, plan, usage numbers only.

## Protocol (`crates/warpforge-protocol` + `desktop/src/protocol.ts`)

Commands (mirror the existing `agents.*` naming):

| Method | Params | Returns |
|---|---|---|
| `accounts.list` | `{}` | `{ accounts: AccountInfo[] }` |
| `accounts.import` | `{ agent_id, label }` | imports the agent's *current* live home into a new profile |
| `accounts.login` | `{ agent_id, label }` | creates an empty profile and starts an interactive login (Phase 4) |
| `accounts.set_active` | `{ agent_id, account_id }` | `{}` |
| `accounts.rename` | `{ account_id, label }` | `{}` |
| `accounts.remove` | `{ account_id }` | `{}` (deletes the profile dir) |
| `accounts.refresh_usage` | `{ agent_id? }` | `{ accounts: AccountInfo[] }` |

Event: `accounts.updated { accounts: AccountInfo[] }` — also emitted after a
session ends, since a finished session updates that account's rate-limit
snapshot. `Snapshot` gains `accounts: Vec<AccountInfo>` so the switcher renders
on first connect.

```rust
pub struct AccountInfo {
    pub id: String,
    pub agent_id: String,
    pub label: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub active: bool,
    pub usage: Option<AccountUsage>,   // None until the account has run once
}
pub struct AccountUsage {
    pub used_percent: f32,
    pub window_minutes: u32,
    pub resets_at: i64,        // unix seconds
    pub secondary: Option<…>,  // same shape, weekly vs 5h window
    pub credits_balance: Option<String>,
    pub observed_at: i64,      // snapshot age — the UI must show staleness
}
```

## Phases

**Order is Claude-first by owner's call** (Claude switching is the felt pain;
Codex must exist but is secondary). Phases 1–2 are shared plumbing, 3–4 deliver
a working Claude switcher, 5 adds Codex, 6–7 are polish.

| # | Phase | Ships |
|---|---|---|
| 1 | env plumbing at the spawn seam — **DONE** | nothing user-visible |
| 2 | accounts core (store, protocol, module) — **DONE** | daemon API, no UI |
| 3 | **Claude accounts — vault + swap** — **DONE** | switching works headlessly |
| 4 | **desktop switcher UI** — **DONE** | the feature, Claude-only |
| 5 | Codex accounts — per-account homes | Codex in the same switcher |
| 6 | usage readouts | percentages in the chip |
| 7 | per-task account override | Codex only (see below) |

### Phase 1 — env plumbing at the spawn seam (no UI)
- `acp.rs::spawn_acp_session` takes `env: HashMap<String, String>` and applies
  `child_command.envs(env)`. The signature already carries
  `#[allow(clippy::too_many_arguments)]`; if it grows further, fold
  `default_model` + `config_overrides` + `env` into a `SpawnOptions` struct in
  the same commit rather than later.
- Update all five call sites (`actor.rs:3326`, `acp.rs:390`, three tests).
- `actor.rs`: `fn resolve_agent_env(&self, agent: &str, account: Option<&str>)`
  → `{}` when no account is configured. **Ship this phase with an empty map and
  verify nothing regresses** — it is the whole blast radius on the hot path.
- Success: `cargo test`, one real Codex task runs unchanged.

### Phase 2 — accounts core (agent-agnostic)
New `src/daemon/accounts.rs` + store + protocol, with no agent-specific logic
beyond a trait-ish split (`fn activate(&self, account) `, `fn identity(&self)`,
`fn env_for(&self, account)`):
- SQLite tables `agent_accounts` + `active_account` (schema above), created with
  the existing additive `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` pattern.
- Account vault root `~/.warpforge/accounts/<agent_id>/<slug>/`, 0700, files
  0600, with an ownership marker file containing the account id — port Orca's
  `managed-auth-path.ts`: refuse to read or write a vault path that is a
  symlink, escapes the root, or lacks a matching marker. This is the guard that
  stops a crafted account row from making the daemon overwrite arbitrary files.
- `accounts.list/import/rename/remove/set_active` handlers in `actor.rs` +
  `server.rs`, following the `agents.update` pattern; `accounts.updated` event;
  `Snapshot.accounts`.
- `resolve_agent_env(agent, account)` wired into `start_session`, still returning
  an empty map until Phase 3 fills it.
- Success: store roundtrip tests, vault-ownership rejection tests (symlink,
  path escape, wrong marker), `cargo clippy` clean.

### Phase 3 — Claude accounts (the one the owner actually wants) — **DONE**
Implemented in `src/daemon/claude_auth.rs` (credential storage) and
`accounts::activate_claude_account`. Two deviations from the plan as written,
both discovered while building:

- **The live-session gate was not needed and was not built.** Its purpose in
  Orca is to stop *their* managed OAuth refresh from double-rotating a
  single-use token under a running CLI. Warpforge never initiates a refresh — it
  only copies whatever the CLI itself produced. The gate becomes mandatory the
  moment phase 6 fetches usage over OAuth, since that path *does* refresh.
- **Write-back needs an identity check the plan missed.** Capturing the live
  credentials under the outgoing account is wrong when the user signed into a
  different account from a terminal since the last switch: "switch to personal"
  would then log them into that other login. The credentials blob carries no
  identity, so `live_belongs_to` compares Claude's own `oauthAccount.emailAddress`
  and skips write-back on a clear mismatch (unknown identity still writes back,
  preserving token rotation).

Copy Orca's model: **one config dir, per-account credential vault, swap on
activate.** Orca isolates Claude by `CLAUDE_CONFIG_DIR` only for WSL
(`runtime-auth-service.ts:292`); on the host it materializes the selected
account's credentials into the live runtime config dir
(`runtime-auth-service.ts:426,550`). Follow that, because a per-account config
dir would also fragment skills, plugins, settings, and project history.

- Vault per account: `~/.warpforge/accounts/claude/<slug>/` holding
  `.credentials.json` (0600) and `oauth-account.json` (the `oauthAccount` block
  copied out of `.claude.json`, for label/email/plan display).
- On macOS also mirror the blob into our own keychain service
  (`Warpforge Claude Managed Credentials`, account = our account id), matching
  Orca's `ORCA_CLAUDE_SERVICE`. Keychain is the source of truth when present.
- `activate(account)`:
  1. read the *current* live credentials and write them back into the vault of
     the currently-active account first — otherwise a token refreshed since the
     last switch is lost (this is the failure mode that makes naive swapping
     "log you out at random");
  2. write the target account's blob to `<configDir>/.credentials.json` (atomic,
     0600) **and** to keychain services `Claude Code-credentials` *and*
     `Claude Code-credentials-<sha256(configDir)[..8]>` — Claude 2.1+ reads the
     scoped one, older builds the canonical one (Orca writes both:
     `keychain.ts:38-46`);
  3. update `active_account`, emit `accounts.updated`.
- `env_for` strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, and auth-like
  `ANTHROPIC_CUSTOM_HEADERS`.
- `import_current` — snapshot the live credentials + `oauthAccount` as an
  account. First run auto-imports as `default` and marks it active, so a user
  who never opens the UI sees no change.
- Adding a second account: `claude /login` in a PTY, then "Import current" —
  same shape as Orca's `addAccountFromConfigDir` (`service.ts:116-125`).
- **Live sessions do NOT survive the switch — this was wrong in the plan and
  wrong in the first implementation.** The assumption ("the CLI re-reads
  credentials, so a running agent picks up the new token") does not hold for the
  ACP path: the CLI caches the credentials it authenticated with for the life of
  the process (`getLastKnown` / `setSessionCache` / keychain prefetch in the
  binary). Swapping the store underneath a running agent produced
  *"Failed to authenticate: OAuth session expired and could not be refreshed"*
  on the next message. The daemon now retires that agent's live sessions on a
  switch (`retire_sessions_for_agent`); `SessionPrompt` already resumes a dead
  session via `session/load`, so history survives and the next message runs on
  the new account in a fresh process.
- **Do not create `<configDir>/.credentials.json` where the CLI does not keep
  one.** On a keychain-backed macOS install the file is absent; writing it adds
  a second source of truth that nothing updates, so a later rotation lands in
  the keychain while the file keeps a dead token.
- Orca's `live-pty-gate.ts` remains unported and unnecessary while we never
  refresh tokens ourselves:
  - Track live Claude sessions (we already have `self.sessions`) and **persist
    their ids**, so a session that outlived a daemon restart still counts.
  - **Never run a managed token refresh while a live Claude session exists.** The
    OAuth refresh token is single-use and rotates; refreshing under a live CLI
    double-rotates it and one copy dies with `invalid_grant`
    (`runtime-auth-service.ts:206`). Defer the refresh until sessions drain.
  - Handle the "live CLI wrote empty tokens after losing a refresh race" case —
    Orca validates the changed runtime blob before persisting it, because
    storing it *"would log out every new session"* (`:373`).
- **Document the blast radius:** this is a global swap. The user's terminal
  `claude` follows the active account too. Unlike Codex, running sessions *do*
  follow the switch — that asymmetry must be visible in the UI copy, not implied.
- Success: activate/rollback tests against a temp config dir + fake `security`
  binary; a test asserting the write-back-before-switch step; no secret ever in
  `AccountInfo`, events, or logs.

### Phase 4 — desktop switcher UI (Claude-only at this point) — **DONE**
- `components/AccountSwitcher.tsx` — chip in `AppHeader.tsx`, right cluster next
  to `UpdateControl` (`AppHeader.tsx:104`). Shows `AgentLogo` + active label
  (+ usage percent once Phase 6 lands); dropdown lists that agent's accounts.
  One chip per enabled agent that has ≥2 accounts.
- `components/AccountsPanel.tsx` — rendered inside Settings → Agents
  (`Settings.tsx:197`, under `AgentSetupPanel`): import, rename, remove, mark
  active, refresh.
- `daemon.ts` gains `listAccounts/importAccount/setActiveAccount/renameAccount/
  removeAccount/refreshAccountUsage` next to `saveAgents` (`daemon.ts:902`), and
  handles the `accounts.updated` event beside `agents.updated`
  (`daemon.ts:851`).
- Switching is instant (credential pointer / env, not a re-auth). State the
  per-agent difference plainly in the dropdown, because it is not guessable:
  **Claude** — running sessions follow the switch on their next request;
  **Codex** — running sessions keep their account until restarted.
- Success: vitest for the switcher (renders accounts, marks active, calls the
  daemon once), `bun run lint && bun run typecheck`.

**This is the shippable milestone.** Phases 1–4 give a working Claude account
switcher. Everything after is Codex and polish.

### Phase 5 — Codex accounts (per-account homes)
Different mechanism from Claude: Codex isolates cleanly by `CODEX_HOME`, so no
credential swapping — each account gets its own home and the env decides.

- `home_dir(codex, slug)` under the accounts root, 0700.
- `materialize(shared, home)` — the symlink policy table above, idempotent, run
  on every activation. Port t3code's four guards (`CodexHomeLayout.ts`) and
  Orca's ownership markers (`codex-home-paths.ts:73`); never write inside
  `~/.codex`.
- `identity(home)` — base64url-decode the `id_token` payload (no signature check;
  it is a local file we already trust) → email, plan, account id. Never log the
  token.
- `env_for(account)` → `{ "CODEX_HOME": home_dir }`.
- Adding accounts — Orca implements both paths: `doAddAccount` spawns
  `codex login` with `CODEX_HOME=<managed home>` (`service.ts:1651`), and
  `addAccountFromHome` imports an already-authenticated home
  (`service.ts:288-296`, error text: *"No Codex credentials found in …. Run
  `codex login` into this directory first."*). Ship in that order of effort:
  - **5a:** "Import current account" + an "import from home path" field.
  - **5b:** "Add account" runs `codex login` with `CODEX_HOME=<account home>` in
    a PTY (daemon already owns PTY machinery via `agent.rs`), surfacing the
    device/browser URL in the UI.
- Success: materialization tests (fresh home, re-run, wrong-target symlink,
  non-symlink collision, `auth.json`-is-symlink rejection); a test asserting the
  child process's `CODEX_HOME` equals the selected account home.

### Phase 6 — usage readouts
Claude first (matches phase order): `https://api.anthropic.com/api/oauth/usage`
with the account's OAuth credentials (Orca `claude-fetcher.ts:46`), PTY
statusline parse as fallback (`claude-pty.ts`). Until then the chip shows plan /
seat tier from `oauthAccount`, which needs no network at all.

**Prerequisite the earlier phases dodged:** fetching usage over OAuth means
refreshing tokens, and a refresh under a live Claude CLI double-rotates a
single-use token (`invalid_grant`, random logout). Port Orca's
`claude-accounts/live-pty-gate.ts` *before* this phase, not after: track live
Claude sessions, persist their ids across daemon restarts, and defer any managed
refresh until they drain.

For Codex, the sessions dir is shared and rollouts carry no account id, so the
file alone cannot say whose limits it recorded. Attribution comes from our own
data:

- Warpforge already knows `task → session_id` (`tasks.session_id`) and, after
  Phase 2, `task → account_id`. The rollout filename is
  `rollout-<ts>-<session_uuid>.jsonl`, so `account → newest rollout` is a lookup
  over our own tasks, not a directory scan.
- `usage(account)` — take that account's newest known rollout, tail-scan the last
  ~200 lines for the final `rate_limits` object → `AccountUsage`, with
  `observed_at` = file mtime.
- Bootstrap case (account imported, never run through Warpforge): scan the whole
  shared sessions dir once for the newest rollout and attribute it to the account
  that owns the *current* `~/.codex/auth.json`. Only valid at import time; mark
  the snapshot as such and never re-run this heuristic afterwards.
- Cache per account with a ~60s TTL (same shape as `latest_npm_version`'s cache
  in `agents.rs`), refreshed on demand and when a session for that account ends.
- Live fallback if the offline path proves flaky: `codex-acp` computes the same
  numbers for its `/status` command. Sending `/status` in a throwaway ACP session
  per account is exact but costs a process spawn each — keep it behind the
  explicit "Refresh" button, never on a timer.
- Orca does not scrape rollouts at all (`rate-limits/codex-fetcher.ts`). It uses
  two live sources, both worth stealing in v2 but not v1:
  1. spawn `codex -s read-only -a untrusted app-server` with that account's
     `CODEX_HOME` and read `rateLimits` off the RPC — same numbers, no parsing of
     on-disk history, works for an account that has never run under Warpforge;
  2. HTTP `https://chatgpt.com/backend-api/wham/usage` and
     `…/wham/rate-limit-reset-credits` with the account's token, for fields the
     app-server strips.
  v1 stays offline-only (rollout tail) because it needs no token handling and no
  network; revisit if the snapshot proves too stale to be useful.
- Success: parser test against a captured rollout fixture; stale snapshots
  render as "33% · 2h ago", never as fresh truth.

### Phase 7 — per-task account (Codex only)
Task creation gets an "Account" selector defaulting to the active one; the choice
is stored in `tasks.account_id` and reused on resume/restart. Possible only for
Codex, where the account is process-scoped env. Claude's swap is global, so its
selector must stay disabled — offering it there would silently lie. Ship only
after Phases 1–6 are stable.

## Risks and gotchas

- **Profile dir must exist before spawn** — codex hard-errors otherwise. Create
  it in `resolve_agent_env`, not only at import time.
- **`CODEX_HOME` can be clobbered by the user's shell startup files.** Orca ships
  a whole mitigation for this: it also exports `ORCA_CODEX_HOME` and re-exports
  `CODEX_HOME="$ORCA_CODEX_HOME"` *after* profile/rc files run
  (`local-pty-shell-ready.ts:131,248,307`). Warpforge spawns `sh -c <command>`,
  which sources no rc files, so we are safe today — but the moment anything runs
  the agent through a login/interactive shell, this bites. Add a test asserting
  the child's `CODEX_HOME` equals the selected account home.
- **Claude auth env vars silently win over the selected account** — strip them
  (Phase 5). A stale `ANTHROPIC_API_KEY` in the daemon's environment means every
  account switch appears to do nothing.
- **Shared config drift**: symlinked `config.toml` means a per-account model or
  MCP tweak is impossible. Acceptable for v1; call it out in the UI copy.
- **Token refresh under concurrency**: two sessions on the *same* account share
  one `auth.json`. That is exactly today's behavior with one home, so no new
  risk — but do not "optimize" by pointing two profiles at one file.
- **Removing an account** deletes its profile dir including its session
  rollouts. Confirm destructively in the UI; never remove the last account
  without also clearing `active_account`.
- **Secrets**: 0700 dirs, 0600 files, no tokens in `AccountInfo`, no tokens in
  daemon logs (`WARPFORGE_ACP_DEBUG` prints raw ACP frames — env is not in
  them, keep it that way).
- **Provider terms**: this manages accounts the user already owns and logs into
  manually. Do not automate account creation, and do not present the feature as
  a way to evade rate limits beyond what each account's plan allows.

## Rejected alternatives

- **Rewrite `~/.codex/auth.json` on switch (Orca's mechanism)** — loses the
  refresh-token write-back, mutates the user's terminal environment, blocks
  concurrent accounts. Kept only for Claude, and only if the Keychain spike
  forces it.
- **`OPENAI_API_KEY` env per account** — different auth mode, different billing,
  not what the ChatGPT-plan users this targets are doing.
- **Parsing usage from ACP session updates** — `SessionUpdate { kind: "usage" }`
  (`desktop/src/lib/sessionUsage.ts`) is context-window usage for one session,
  not plan rate limits. Different number; do not conflate them in the UI.
- **Wrapper script per account instead of env** — an extra process layer and a
  worse failure mode than `Command::envs`.
- **Private `sessions/` per account** (my first draft) — makes usage attribution
  trivial but hides every thread started under the other account. t3code shares
  the sessions dir for exactly this reason; attribution is solved with our own
  session→account map instead.
- **One provider instance per account (t3code's UX)** — correct for a product
  with a provider registry and per-provider accent colors; Warpforge has a flat
  agent list, so a switcher chip is the smaller change and matches what the user
  asked for.
- **Overriding `HOME` instead of `CODEX_HOME`/`CLAUDE_CONFIG_DIR`** — relocates
  the macOS login keychain lookup (`$HOME/Library/Keychains`), so the spawned
  CLI reports "Not logged in". Documented the hard way in
  `ref-projects/t3code/apps/server/src/provider/Drivers/ClaudeHome.ts:27`.
