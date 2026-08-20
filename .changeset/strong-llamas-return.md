---
"warpforge": patch
---

Log reading tools now behave like `kubectl --timestamps | grep | tail`: every line
carries a UTC timestamp, `filter` runs over the whole retained buffer before the
newest `limit` are kept, and a new `context` option adds surrounding lines around
each match (`grep -C`).

Log cursors are now stable sequence numbers instead of buffer indexes. Each line
gets a monotonic `seq`; `after` is inclusive of that seq and the response returns
`nextSeq`, so polling for new lines is nearly free even as the ring buffer drops
old ones. `logSeq` in `list_runtime` is the live cursor.

Service lifecycle is now visible in the log stream: `[service running]`,
`[service stopped]`, and `[service failed: exit code=N]` markers are injected on
state transitions, so a restarting process no longer looks like empty logs.