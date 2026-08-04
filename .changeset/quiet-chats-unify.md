---
"warpforge": patch
---

Chat rendering is now identical between MissionControl and TaskDetail views
by extracting a shared SessionChat component with LegendList virtualization,
work-group toggles, MessageActions overlay, and unified composer routing.
