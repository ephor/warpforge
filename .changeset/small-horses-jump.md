---
"warpforge": patch
---

Long conversations no longer grow memory without limit. The app used to keep
every line of everything your agents had said in memory and reload it all on
start, so the more work agents did, the more memory the app held onto even when
it was only showing the latest exchange. It now keeps just what the current
view needs — the latest message and the most recent exchange — and loads the
rest only when you resume a session or open a project. Resuming a session
still shows each reply once, and nothing in the chat history is lost.