import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";

import App from "./App";
import { daemon } from "./daemon";
import { queryClient } from "./query";

// CSS is loaded for its global side effect at the application boundary.
// eslint-disable-next-line import/no-unassigned-import
import "./globals.css";

void daemon.connect().catch(() => {
  /* Reconnect loop takes over */
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster
        theme="dark"
        position="bottom-right"
        closeButton
        duration={4000}
        toastOptions={{
          classNames: {
            toast:
              "!rounded-xl !border-border !bg-popover !p-4 !text-xs !text-popover-foreground !shadow-2xl data-[styled=false]:!border-0 data-[styled=false]:!bg-transparent data-[styled=false]:!p-0 data-[styled=false]:!shadow-none",
            description: "!text-muted-foreground",
            closeButton:
              "!border-border !bg-secondary !text-secondary-foreground hover:!bg-accent hover:!text-accent-foreground",
            info: "[&_[data-icon]]:!text-primary",
            success: "[&_[data-icon]]:!text-ok",
            warning: "[&_[data-icon]]:!text-warn",
            error: "[&_[data-icon]]:!text-destructive",
          },
        }}
      />
    </QueryClientProvider>
  </React.StrictMode>,
);
