---
"warpforge": patch
---

Scheduled automation runs now tell the agent they are scheduled. Every run
starts with a short line naming the automation and its run number and saying
the turn is unattended, so the agent delivers the result instead of asking a
clarifying question nobody is there to answer. This matters most for
automations set to reuse the same task every run, where the identical prompt
used to arrive in one conversation over and over and read as a person repeating
themselves. Your prompt is passed through unchanged underneath, and it no
longer has to explain that the run is automated.
