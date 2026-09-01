---
"warpforge": minor
---

See where a project's port range comes from — and fix conflicts on your machine only.

Each project now shows whether its port range was declared in the team's shared config, set as a local override on your machine, or assigned automatically. When two projects claim the same range, the affected project says so up front and names the other project, with a one-field fix that applies to your machine only — the team's shared config is never edited from here. An existing local override can be cleared just as easily, and the badge stays visible the whole time so a machine-only range can't silently outrank the config. Pinned service ports are marked in the runtime view, with a reminder that a pinned port fails rather than moves when it's already taken.
