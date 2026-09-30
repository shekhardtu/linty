import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ActionTooltip } from "./components/shared/ActionTooltip.component";
import "./styles/globals.css";
import "./styles/motion.css";
import { reportFrontendError } from "./services/telemetry.service";

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error) => { console.error(error); reportFrontendError("frontend_render"); },
}).render(
  <StrictMode>
    <App />
    <ActionTooltip />
  </StrictMode>,
);
