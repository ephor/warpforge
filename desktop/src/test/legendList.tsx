/**
 * Stand-in for `@legendapp/list/react` under jsdom.
 *
 * The real list measures its scroller to decide what to mount, and jsdom
 * reports every box as zero — it would render no rows at all. This renders the
 * whole `data` array and exposes `onEndReached` as a "scroll to end" button, so
 * a test can drive paging without a layout engine.
 *
 * Use as: `vi.mock("@legendapp/list/react", () => import("@/test/legendList"))`.
 */
export function LegendList({
  data,
  renderItem,
  keyExtractor,
  onEndReached,
  ListFooterComponent,
}: {
  data: readonly unknown[];
  renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
  keyExtractor: (item: unknown, index: number) => string;
  onEndReached?: () => void;
  ListFooterComponent?: React.ReactNode;
}) {
  return (
    <div>
      {data.map((item, index) => (
        <div key={keyExtractor(item, index)}>{renderItem({ index, item })}</div>
      ))}
      <button type="button" onClick={() => onEndReached?.()}>
        scroll to end
      </button>
      {ListFooterComponent}
    </div>
  );
}
