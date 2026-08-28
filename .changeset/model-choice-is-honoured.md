---
"warpforge": patch
---

The model you pick for a task is now the model that runs it. Warpforge remembers
your choice for the whole task, re-applies it whenever a session reconnects, and
tells you when an agent refuses it instead of quietly falling back to its own
default — a banner in the session and an entry in the "Needs you" rail name the
model that was requested and why it did not take.

The New Task picker no longer says "Default" when it will actually reuse the
model you last chose; it shows which one you will inherit. And when you ask an
agent to start a sub-agent on a specific model, it can look up the models that
agent really offers and pick a valid one, instead of guessing a name that
silently does nothing.
