/** Adds deterministic occurrence suffixes when renderable values are not unique. */
export function withOccurrenceKeys<T>(items: readonly T[], identity: (item: T) => string) {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const base = identity(item);
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return { item, key: `${base}:${occurrence}` };
  });
}
