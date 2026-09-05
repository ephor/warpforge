---
"warpforge-desktop": patch
---

Lines across the app read as a hierarchy instead of a mesh. Every border used to be the same colour with a transparency picked by hand per component, so where the split handle, the conversation header and the workspace tabs meet, one continuous rule rendered in three different shades. Borders now come in three deliberate weights — the boundary between panes, the outline of a panel, and the hairline between rows inside one. This also fixes panels that asked for an invisible border and drew one anyway, which is where several of the stray double lines came from.
