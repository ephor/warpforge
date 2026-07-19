import { FILE_EXTENSIONS, FILE_NAMES } from "./fileIconMap";

// Vite emits each referenced SVG as an asset; this map is icon id -> URL.
const modules = import.meta.glob("../assets/file-icons/*.svg", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;

const ICON_URLS: Record<string, string> = {};
for (const [path, url] of Object.entries(modules)) {
  const id = path.slice(path.lastIndexOf("/") + 1, -4);
  ICON_URLS[id] = url;
}

/** Resolve a file path to a bearded-icons id (exact filename first, then the
 *  longest matching multi-dot extension, e.g. `foo.d.ts` -> `d.ts` before `ts`). */
function resolveIconId(path: string): string | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  const byName = FILE_NAMES[name];
  if (byName) {
    return byName;
  }
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    const id = FILE_EXTENSIONS[ext];
    if (id) {
      return id;
    }
  }
  return null;
}

/** URL of the file-type icon for a path, or null to fall back to a generic icon. */
export function getFileIconUrl(path: string): string | null {
  const id = resolveIconId(path);
  return id ? (ICON_URLS[id] ?? null) : null;
}
