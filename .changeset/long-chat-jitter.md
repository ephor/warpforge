---
"warpforge": patch
---

Long chats no longer shimmer while an agent streams. The transcript used to
slide and fidget as messages grew, especially in sessions with hundreds of
rows: unmeasured rows drifted, and expanding or collapsing a group of tool
results would yank the viewport off what you were reading.

The transcript list now keeps its visible position anchored to the conversation
edge instead of re-measuring everything on every token. Streaming text settles
in place, and folding a work group keeps the toggle under your cursor instead
of chasing the latest message. We also ported the upstream LegendList anchoring
patch (and bumped `@legendapp/list` to 3.3.5) so the scroll engine can actually
hold the end steady while content streams in.
