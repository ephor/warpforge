---
"warpforge-desktop": patch
---

Opening a change from the chat lands on the change itself, not at the top of the file. The editor that does the scrolling loads on demand and waits for its own copy of the file, which on a cold open took longer than the two and a half seconds the highlight was given — so by the time the editor was ready, the request to scroll had already expired. The highlight now waits for the editor and starts fading only once the change is actually on screen, and the file is kept rendered a little earlier so it is ready to be scrolled to.
