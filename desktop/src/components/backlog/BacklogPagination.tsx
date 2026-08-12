import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PAGE_SIZES = [10, 20, 30, 50];

interface BacklogPaginationProps {
  page: number;
  pageSize: number;
  /** Rows matching the current filters, as reported by the daemon. */
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

export function BacklogPagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: BacklogPaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const canPrevious = page > 0;
  const canNext = page + 1 < pageCount;

  return (
    <div className="flex w-full flex-col-reverse items-center justify-between gap-2 px-3 py-1 sm:flex-row sm:gap-4">
      <span className="tnum flex-1 whitespace-nowrap text-xs text-muted-foreground">
        {total} {total === 1 ? "item" : "items"}
      </span>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap text-xs font-medium">Rows per page</span>
          <Select value={`${pageSize}`} onValueChange={(value) => onPageSizeChange(Number(value))}>
            <SelectTrigger className="h-7 w-16" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top">
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={`${size}`}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span className="tnum whitespace-nowrap text-xs font-medium">
          Page {page + 1} of {pageCount}
        </span>
        <div className="flex items-center gap-1">
          <Button
            aria-label="Go to first page"
            variant="outline"
            size="icon"
            className="hidden size-7 lg:flex"
            onClick={() => onPageChange(0)}
            disabled={!canPrevious}
          >
            <ChevronsLeft />
          </Button>
          <Button
            aria-label="Go to previous page"
            variant="outline"
            size="icon"
            className="size-7"
            onClick={() => onPageChange(page - 1)}
            disabled={!canPrevious}
          >
            <ChevronLeft />
          </Button>
          <Button
            aria-label="Go to next page"
            variant="outline"
            size="icon"
            className="size-7"
            onClick={() => onPageChange(page + 1)}
            disabled={!canNext}
          >
            <ChevronRight />
          </Button>
          <Button
            aria-label="Go to last page"
            variant="outline"
            size="icon"
            className="hidden size-7 lg:flex"
            onClick={() => onPageChange(pageCount - 1)}
            disabled={!canNext}
          >
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
