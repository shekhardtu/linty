import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ActionTooltip } from "./components/shared/ActionTooltip.component";
import "./styles/globals.css";
import "./styles/motion.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <ActionTooltip />
  </StrictMode>,
);
