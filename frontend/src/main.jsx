import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AutoTranslate from "./components/AutoTranslate";
import StartupSplash from "./components/StartupSplash";
import "./styles/global.css";
import "./styles/components.css";
import "./styles/theme.css";
import "./styles/responsive.css";
import "./styles/theme-overrides.css";
import "./styles/performance-overrides.css";
import "./styles/modern-system.css";
import "./styles/dark-contrast.css";
import "./styles/dashboard-polish.css";
import "./styles/visual-polish.css";
import "./styles/theme-backgrounds.css";
import "./styles/rainbow-theme.css";
import "./styles/dark-contrast-final.css";
import "./styles/motion-polish.css";
import "./styles/layout-mobile-polish.css";
import "./styles/product-experience.css";
import "./styles/scan-theme.css";
import "./styles/obsidian-contrast-fix.css";
import { applyTheme, getTheme } from "./lib/theme";
import { LanguageProvider } from "./components/LanguageProvider";

// The OCR/backend contract uses zero-based image indexes (first uploaded image = 0).
// ScanVisualCheck historically accepted one-based declaration image indexes and subtracts
// one during normalization. Keep that UI contract explicit here so an image never shifts
// to the previous package side before its OCR box is rendered.
window.addEventListener("parakh:declaration-evidence", (event) => {
  if (!Array.isArray(event.detail)) return;

  event.detail.forEach((item) => {
    if (!item || item.imageIndex == null) return;
    const index = Number(item.imageIndex);
    if (!Number.isInteger(index) || index < 0) return;
    item.imageIndex = index + 1;
  });

  try {
    window.sessionStorage.setItem("parakhDeclarationEvidence", JSON.stringify(event.detail));
  } catch {
    // Storage is only a refresh fallback; the live event remains authoritative.
  }
}, { capture: true });

applyTheme(getTheme());

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <LanguageProvider>
      <StartupSplash>
        <AutoTranslate />
        <App />
      </StartupSplash>
    </LanguageProvider>
  </StrictMode>
);
