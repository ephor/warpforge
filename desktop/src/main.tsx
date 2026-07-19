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
        position="bottom-right"
        richColors
        closeButton
        duration={4000}
        toastOptions={{
          className: "text-xs",
        }}
      />
    </QueryClientProvider>
  </React.StrictMode>,
);
