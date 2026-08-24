---
"warpforge": minor
---

Durable memory for agents: separate `~/.warpforge/memory.db` (global + per-project overlay), FTS5 search with optional vector hybrid (fastembed MiniLM-L6-v2 + vec0, RRF fusion, cosine). 8 MCP tools (`memory_store/search/list/update/delete`, `memory_edges/addEdge`, `memory_dream`, `memory_list/resolve_compaction`) so any harness can read/write. Dreaming pass finds stale/duplicate/contradiction proposals (heuristic + code-aware LLM prompt), writes to `memory_compaction_log` for human approve/reject — manual Dream button in Settings or idle/cron background. Settings now shows per-scope stats and pending compaction count.
