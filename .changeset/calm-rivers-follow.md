---
"warpforge": minor
---

Adds the foundation for configurable task workflows. Projects can now define
workflow templates as YAML files in `.warpforge/workflows/` — configuring the
planning stage, reviewer agents and models, review context, and the review ⇄
fix iteration limit — and two built-in templates (Review loop, Plan + review
loop) ship with the app and can be copied into a project for customization.
The workspace config also gains a new preferred home at
`.warpforge/workspace.yaml`: existing root-level config files keep working
unchanged, while newly generated configs land in the `.warpforge/` directory.
