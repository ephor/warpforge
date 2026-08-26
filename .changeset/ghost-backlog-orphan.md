---
"warpforge": patch
---

Fix ghost backlog rows after deleting a task linked to a tracker item. Deleting a task now clears `backlog_items.task_id` / `tracker_links.task_id` and YAML `task_id` refs, resets status to `todo`, and invalidates the backlog query. The board only shows "Open task" when the task still exists.
