import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CapsulePanel } from "@/components/CapsulePanel.component";
import "@/styles/capsule.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CapsulePanel />
  </StrictMode>,
);
