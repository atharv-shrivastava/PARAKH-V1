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
