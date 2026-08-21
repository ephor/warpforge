---
"warpforge": patch
---

Service log timestamps now say they are UTC. Outside the UTC zone the bare
timestamp read as a clock that had fallen hours behind, so a healthy service
looked stalled; the lines now end in `Z`.
