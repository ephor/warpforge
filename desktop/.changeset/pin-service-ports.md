---
"warpforge-desktop": minor
---

Pin the exact ports your team's services run on — and commit them to the repo.

Declare a port range in a project's config (`ports.range: "4200-4299"`), and every service in that project that declares a port now binds exactly that port. No more "port 3000 actually means 4000-something": if a pinned port is taken, the service fails loudly and tells you why, instead of silently moving. Services that prefer the old behaviour can opt back in with `portFallback: auto`.

Ranges are assigned per project and stick for good — adding or removing a project no longer shuffles everyone else's ports, and two machines that declare the same range in the config now agree on the same ports. If two projects claim the same range, one of them refuses to start services until the conflict is resolved. A declared port that sits outside the project's range fails loudly too, with both ways out named in the error: move the port inside the range, or set `portFallback: auto`.

One thing to know going in: a service's declared port used to be ignored — any free port in the project's range was used and passed to the app as `PORT`. In a project that declares a range it is now the exact port the service must bind, so if your app doesn't read `PORT` (hardcoded port instead), tell it the port via the environment or a `--port $PORT` flag in its command, or it will end up listening somewhere Warpforge isn't looking.
