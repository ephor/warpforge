import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import App from "./App";
import { daemon } from "./daemon";
import { queryClient } from "./query";
import "./globals.css";

void daemon.connect().catch(() => {
  /* reconnect loop takes over */
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
