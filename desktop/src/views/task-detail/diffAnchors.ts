export const fileAnchor = (path: string) => `diff-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;

export const hunkAnchor = (path: string, index: number) => `${fileAnchor(path)}-hunk-${index}`;
