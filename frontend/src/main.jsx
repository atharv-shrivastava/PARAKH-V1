import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AutoTranslate from "./components/AutoTranslate";
import CoinCalibrationAssist from "./components/CoinCalibrationAssist";
import ScanScopedUnableToVerifyReview from "./components/ScanScopedUnableToVerifyReview";
import StartupSplash from "./components/StartupSplash";
import "./styles/global.css";
import "./styles/components.css";
import "./styles/theme.css";
import "./styles/theme-dark.css";
import "./styles/responsive.css";
import "./styles/modern-system.css";
import "./styles/theme-backgrounds.css";
import "./styles/rainbow-theme.css";
import "./styles/product-experience.css";
import "./styles/scan-theme.css";
import "./styles/layout-fix.css";
import "./styles/recorded-product-fixes.css";
import "./styles/ocr-product-detail-theme.css";
import "./styles/theme-overrides.css";
import "./styles/theme-final-overrides.css";
import "./lib/localBarcodeDetector";
import { installComplianceStatusDrilldown } from "./lib/complianceStatusDrilldown";
import { applyTheme, getTheme } from "./lib/theme";
import { LanguageProvider } from "./components/LanguageProvider";

applyTheme(getTheme());
installComplianceStatusDrilldown();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <LanguageProvider>
      <StartupSplash>
        <AutoTranslate />
        <App />
        <ScanScopedUnableToVerifyReview />
        <CoinCalibrationAssist />
      </StartupSplash>
    </LanguageProvider>
  </StrictMode>
);
