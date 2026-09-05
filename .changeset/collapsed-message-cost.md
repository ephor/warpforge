---
"warpforge-desktop": patch
---

Long pasted messages no longer freeze the app. A collapsed message showed only its first few lines but still rendered every one of them behind the scenes, so scrolling past a pasted log of a few thousand lines locked the window — text could not be selected and the composer refused input until it finished. Collapsed messages now render only the part you can see; the rest is rendered when you click "Show full message".
