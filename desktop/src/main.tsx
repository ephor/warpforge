import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { daemon } from "./daemon";
import "./globals.css";

void daemon.connect().catch(() => {
  /* reconnect loop takes over */
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
