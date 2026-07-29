---
"warpforge": minor
---

Repeat review rounds now continue in the same reviewer session by default:
after a fix, each reviewer receives the fixer's summary, its own previous
findings, and the fresh diff, and must verify every finding is actually
resolved — plus re-check the changes for regressions — instead of reviewing
from scratch. If a reviewer's session is gone (daemon restart, agent death),
the round falls back to a fresh session whose prompt carries the previous
findings for verification. A new `review.reask: same_session | fresh` option
in workflow files controls this per workflow. Finished pipelines also now
shut down every stage agent session, including completed ones — previously
reviewers and implementers kept running in the background until the daemon
restarted.
