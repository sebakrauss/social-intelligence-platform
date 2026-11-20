/**
 * MESSAGES-UX-01 — entry point. Loads Wrenkind's real foundations (tokens, reset, base, motion) read-only, then the
 * prototype. Any address outside /messages is replaced by /messages (the prototype has one destination).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/ui/foundations/reset.css";
import "@/ui/foundations/tokens.css";
import "@/ui/foundations/base.css";
import "@/ui/foundations/motion.css";
import "./fonts.css";
import { App } from "./app";

if (!window.location.pathname.startsWith("/messages")) window.history.replaceState(null, "", "/messages");

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
