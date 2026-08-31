# 0006 — Ports are pinned explicitly, not derived from list positions

**Status:** accepted (2026-08-31)

## Context

Port allocation today is positional. `port_range(project_index)`
(`src/ports.rs:14`) returns `4000 + project_index*100 .. +99`, and
`project_index` is the project's *position* in `~/.warpforge/projects.json`
(`src/daemon/actor/run.rs:123`). Two consequences:

- Two developers who registered the same projects in a different order get
  different ranges, so no port can be committed to shared config.
- Adding or removing a project shifts the range of every project after it.

Meanwhile, a service's declared port is ignored: `allocate()`'s port parameter
is named `_desired_port` and unused (`src/ports.rs:26`), so `port: 3000` in
`.warpforge/workspace.yaml` effectively means "any port in 4000–4099". And when
allocation fails, the service silently falls back to `original_port`
(`src/service.rs:307-312`) — a listener on an unallocated port that nothing
interpolated or accounted for.

The point of a port anyone writes down — in `.env`, Postman, a k8s manifest —
is that external tooling points at that exact port. Nothing in the current
scheme supports that.

## Decisions

**Ranges become data, not arithmetic.** `.warpforge/workspace.yaml` gains a
`ports.range` key (`"4200-4299"`), committed and shared by the team.
`~/.warpforge/projects.json` entries gain a `portRange { start, size }`,
assigned once at registration and never index-derived again. The registry
change alone removes the add/remove reshuffle.

**A service `port:` inside a declared range is an absolute pinned port.**
Absolute values only — no offset syntax (rejected below).

**Range precedence, strongest first:** local registry override
(`portRangeOverride`) > explicit `ports.range` from config > sticky auto range
from the registry > fresh scan from 4000 upward for a free 100-block. Explicit
ranges never relocate; implicit ones relocate around them.

**Range conflicts are not auto-resolved.** Two projects declaring the same
explicit range put the project in a `PortConflict` state: its services refuse
to start, and the UI offers a local relocation that writes `portRangeOverride`
to the registry — never edits the shared config.

**A pinned port that is already bound fails loudly** instead of shifting. That
is the point of pinning. Per-service `portFallback: auto` opts back into
shifting. Unpinned services keep today's first-free-in-range behaviour.

**Migration:** a registry entry with no `portRange` gets one computed from its
current index on first daemon boot, then frozen. Nobody's ports move on
upgrade.

## Rejected alternatives

- **Offset ports** (`port: +10` relative to range start). Survives a local
  range move, but adds a second port syntax and makes the config unreadable
  next to the `.env` files that hold the literal. Rejected for now; revisit
  only if local relocation turns out to be common.
- **Keeping index-derived ranges and pinning only service ports inside them.**
  Does not work — the range itself differs per machine, so the pinned value is
  not portable.
- **Auto-relocating an explicitly declared range on conflict.** Silently
  defeats the purpose of declaring it.
- **Editing the shared config to resolve a local conflict.** Pushes one
  developer's machine-local problem into everyone else's checkout.

## Invariants

1. **Never write a locally-resolved port decision into
   `.warpforge/workspace.yaml`.** Local overrides live in the registry only.
2. **`port_range` must never again be derived from a list index.** Ranges are
   stored, assigned once, and frozen.
3. **Teardown sweeps keep using `ports::allocated_in_ranges`**
   (`src/ports/mod.rs`), which only returns ports this process handed out. A
   pinned range still holds processes warpforge did not start, and must not
   kill them.
4. **A pinned port is a hard constraint.** A silent fallback is a bug, not a
   convenience. Every deviation from the pinned value must be opt-in
   (`portFallback: auto`) and visible.
5. **Invariant 3 covers daemon startup cleanup too, not just teardown.** The
   boot-time orphan sweep (an `lsof` range scan against every project's
   range) was removed on 2026-08-31: it could not tell a warpforge orphan
   from a process warpforge never started, which pinned ranges will
   legitimately hold. If orphan cleanup returns, it must be allocation-scoped —
   persisted service allocations read at startup, the startup analogue of
   `ports::allocated_in_ranges` — never a range scan.
