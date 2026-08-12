import { flexRender, type Table as TanstackTable } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import type { WorkItem } from "./types";

interface BacklogTableProps {
  table: TanstackTable<WorkItem>;
  /** First load for this project: there is nothing to show yet, not even stale rows. */
  isLoading: boolean;
  /** Refetching with rows already on screen — dim them rather than blanking the grid. */
  isRefreshing: boolean;
  error?: string;
}

export function BacklogTable({ table, isLoading, isRefreshing, error }: BacklogTableProps) {
  const rows = table.getRowModel().rows;
  const columnCount = table.getVisibleFlatColumns().length;

  return (
    // The refresh dim goes on this block, never on `<tbody>`: animating opacity
    // on a table section promotes it to its own compositing layer in the Tauri
    // WebView, and a paged-back render that starts and cancels the transition
    // within a frame leaves the cells laid out but unpainted until something —
    // a row hover — forces a repaint.
    <div
      className={cn(
        "overflow-hidden rounded-md border",
        isRefreshing && "opacity-60 transition-opacity",
      )}
    >
      <Table className="text-xs">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const { column } = header;
                const sorted = column.getIsSorted();
                const label = flexRender(column.columnDef.header, header.getContext());
                return (
                  <TableHead
                    key={header.id}
                    className="h-8"
                    style={{ width: column.columnDef.size }}
                    aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {column.getCanSort() ? (
                      <button
                        type="button"
                        onClick={column.getToggleSortingHandler()}
                        className="-ml-1.5 flex h-7 items-center gap-1.5 rounded-md px-1.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        {label}
                        {sorted === "asc" ? (
                          <ArrowUp className="size-3 text-muted-foreground" />
                        ) : sorted === "desc" ? (
                          <ArrowDown className="size-3 text-muted-foreground" />
                        ) : (
                          <ChevronsUpDown className="size-3 text-muted-foreground/50" />
                        )}
                      </button>
                    ) : (
                      label
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {isLoading ? (
            Array.from({ length: table.getState().pagination.pageSize }, (_row, rowIndex) => (
              <TableRow key={`skeleton-${rowIndex}`}>
                {Array.from({ length: columnCount }, (_cell, cellIndex) => (
                  <TableCell key={cellIndex}>
                    <span className="block h-3 animate-pulse rounded bg-muted" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : error ? (
            <TableRow>
              <TableCell colSpan={columnCount} className="h-16 text-center text-destructive">
                {error}
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columnCount} className="h-16 text-center text-muted-foreground">
                Nothing here yet.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} style={{ width: cell.column.columnDef.size }}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
