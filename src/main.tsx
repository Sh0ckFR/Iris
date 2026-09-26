import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Benign browser warning fired when a ResizeObserver callback (React Flow, resizable panels)
// causes another layout in the same frame. Nothing is lost; don't report it as an error.
window.addEventListener("error", (e) => {
  if (e.message?.includes("ResizeObserver loop")) e.stopImmediatePropagation();
});

// When a model fails, the AI SDK reports the error through `onError` (which Iris handles and
// shows) and also rejects promises it creates internally; that duplicate is not an app error.
window.addEventListener("unhandledrejection", (e) => {
  if ((e.reason as { name?: string } | undefined)?.name === "AI_NoOutputGeneratedError") e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
