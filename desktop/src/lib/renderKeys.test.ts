import { describe, expect, it } from "vitest";

import { withOccurrenceKeys } from "./renderKeys";

describe("withOccurrenceKeys", () => {
  it("keeps duplicate render values unique without relying on array positions", () => {
    expect(withOccurrenceKeys(["same", "other", "same"], (value) => value)).toEqual([
      { item: "same", key: "same:1" },
      { item: "other", key: "other:1" },
      { item: "same", key: "same:2" },
    ]);
  });
});
