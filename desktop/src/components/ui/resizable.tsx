import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "@/lib/utils";

const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) => (
  <ResizablePrimitive.PanelGroup
    className={cn("flex h-full w-full data-[panel-group-direction=vertical]:flex-col", className)}
    {...props}
  />
);

const ResizablePanel = ResizablePrimitive.Panel;

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean;
}) => (
  <ResizablePrimitive.PanelResizeHandle
    className={cn(
      // Invisible at rest — the panels are already told apart by their own
      // ground, so a permanent grey bar between them is just another line.
      "relative mx-px flex w-px items-center justify-center bg-transparent",
      // `after` is the grab area: 8px wide, so the 1px seam is still easy to hit.
      "after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2",
      // `before` carries the line instead of the 1px element itself, so it can
      // be a soft band rather than a hard rule: 3px wide, blurred, fading to
      // nothing at both sides. Reads lighter than an ordinary border, not
      // brighter. The mask fades it out at the ends so it does not butt into
      // the chrome above and below.
      "before:pointer-events-none before:absolute before:-inset-x-[1px] before:inset-y-0 before:opacity-0 before:blur-[1px] before:transition-opacity before:duration-200",
      "before:bg-[linear-gradient(to_right,transparent,hsl(var(--primary)/1),transparent)]",
      "before:[mask-image:linear-gradient(to_bottom,transparent,black_8%,black_92%,transparent)]",
      "hover:before:opacity-100 focus-visible:before:opacity-100 data-[resize-handle-state=drag]:before:opacity-100",
      "focus-visible:outline-none",
      "data-[panel-group-direction=vertical]:mx-0 data-[panel-group-direction=vertical]:my-px data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-2 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0 data-[panel-group-direction=vertical]:before:inset-x-0 data-[panel-group-direction=vertical]:before:-inset-y-[1.5px] data-[panel-group-direction=vertical]:before:bg-[linear-gradient(to_bottom,transparent,hsl(var(--primary)/0.4),transparent)] data-[panel-group-direction=vertical]:before:[mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]",
      "[&[data-panel-group-direction=vertical]>div]:rotate-90",
      className,
    )}
    {...props}
  >
    {withHandle && <div className="z-10 h-5 w-1 rounded-full bg-border" />}
  </ResizablePrimitive.PanelResizeHandle>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
