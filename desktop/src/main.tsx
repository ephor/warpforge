import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { daemon } from "./daemon";
import { startDemo } from "./demo";
import "./globals.css";

// Demo mode: `?demo` in dev, or a global set by a host page (e.g. the
// single-file design-review build).
declare global {
  interface Window {
    __WARPFORGE_DEMO__?: boolean;
  }
}

if (new URLSearchParams(window.location.search).has("demo") || window.__WARPFORGE_DEMO__) {
  startDemo();
} else {
  void daemon.connect().catch(() => {
    /* reconnect loop takes over */
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
