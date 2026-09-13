import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { clearSession, getUser, apiFetch } from "../lib/auth";
import { useLanguage } from "./LanguageProvider";
import ScanVisualCheck from "./ScanVisualCheck";

const API_URL = "http://localhost:5000/api";
const NAV_ITEMS = [
  ["/", "dashboard", "⌂"],
  ["/scan", "scan", "⌁"],
  ["/ecommerce-inspection", "ecommerce", "▣"],
  ["/shops", "shops", "⌂"],
  ["/products", "products", "◇"],
  ["/history", "history", "↺"],
  ["/reports", "reports", "▤"],
  ["/profile", "account", "◉"],
];

function NavIcon({ children }) {
  return <span className="nav-icon" aria-hidden="true">{children}</span>;
}

function BatchWarningStrip() {
  const [alert, setAlert] = useState(null);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await apiFetch(`${API_URL}/batch-alerts?limit=1`);
        const data = await response.json().catch(() => ({}));
        if (active && response.ok) setAlert(data.alerts?.[0] || null);
      } catch {}
    }
    load();
    const interval = window.setInterval(load, 60000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);
  if (!alert) return null;
  return <div className="parakh-batch-warning"><strong>⚠ Verified batch alert</strong><span>{alert.product?.productName || "Product"} · Batch {alert.batchNumber}</span><span>{alert.message}</span></div>;
}

function Layout() {
  const user = getUser();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useLanguage();
  function logout() { clearSession(); navigate("/login", { replace: true }); }

  return <>
    <style>{`
      /* Single source of truth for the application shell geometry. */
      .app-layout.parakh-grid-shell {
        display: grid !important;
        grid-template-columns: minmax(256px, 256px) minmax(0, 1fr) !important;
        grid-template-rows: minmax(0, 1fr) !important;
        width: 100% !important;
        min-width: 0 !important;
        min-height: 100vh !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow-x: clip !important;
        align-items: stretch !important;
      }
      .app-layout.parakh-grid-shell > .sidebar {
        position: sticky !important;
        top: 0 !important;
        left: auto !important;
        right: auto !important;
        inset: auto !important;
        grid-column: 1 !important;
        grid-row: 1 !important;
        width: 256px !important;
        min-width: 256px !important;
        max-width: 256px !important;
        height: 100vh !important;
        margin: 0 !important;
        box-sizing: border-box !important;
        align-self: start !important;
        z-index: 40 !important;
        overflow-y: auto !important;
      }
      .app-layout.parakh-grid-shell > .main-content {
        grid-column: 2 !important;
        grid-row: 1 !important;
        width: 100% !important;
        min-width: 0 !important;
        max-width: none !important;
        margin: 0 !important;
        padding: 34px !important;
        box-sizing: border-box !important;
        overflow-x: hidden !important;
        position: relative !important;
        left: auto !important;
        right: auto !important;
      }
      .app-layout.parakh-grid-shell > .main-content > * {
        width: 100% !important;
        min-width: 0 !important;
        max-width: 1280px !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        box-sizing: border-box !important;
        position: relative !important;
        left: auto !important;
        right: auto !important;
      }
      .app-layout.parakh-grid-shell > .main-content > .dashboard,
      .app-layout.parakh-grid-shell > .main-content > .dashboard-modern,
      .app-layout.parakh-grid-shell > .main-content > .scan-page {
        width: 100% !important;
        max-width: 1280px !important;
        min-width: 0 !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        left: auto !important;
        right: auto !important;
      }
      @media (max-width: 768px) {
        .app-layout.parakh-grid-shell {
          grid-template-columns: minmax(0, 1fr) !important;
          grid-template-rows: auto minmax(0, 1fr) !important;
        }
        .app-layout.parakh-grid-shell > .sidebar {
          grid-column: 1 !important;
          grid-row: 1 !important;
          width: 100% !important;
          min-width: 0 !important;
          max-width: none !important;
          height: auto !important;
          min-height: 0 !important;
          max-height: none !important;
        }
        .app-layout.parakh-grid-shell > .main-content {
          grid-column: 1 !important;
          grid-row: 2 !important;
          width: 100% !important;
          min-width: 0 !important;
          padding: 18px 12px 30px !important;
        }
        .app-layout.parakh-grid-shell > .main-content > * {
          max-width: 100% !important;
        }
      }
    `}</style>
    <div className="app-layout parakh-grid-shell">
      <aside className="sidebar">
        <div className="logo"><h2>PARAKH</h2><span className="logo-full">Packaged Article Regulatory Assessment &amp; Knowledge Hub</span></div>
        <nav className="navigation">
          <div className="sidebar-section-label">Workspace</div>
          {NAV_ITEMS.slice(0, 3).map(([to, label, icon]) => <NavLink key={to} to={to} end={to === "/"}><NavIcon>{icon}</NavIcon><span className="nav-label">{t(label)}</span></NavLink>)}
          <div className="sidebar-section-label">Catalog</div>
          {NAV_ITEMS.slice(3, 5).map(([to, label, icon]) => <NavLink key={to} to={to} end={to === "/products"}><NavIcon>{icon}</NavIcon><span className="nav-label">{t(label)}</span></NavLink>)}
          <div className="sidebar-section-label">Insights</div>
          <NavLink to="/intelligence"><NavIcon>⌁</NavIcon><span className="nav-label">Compliance intelligence</span></NavLink>
          <NavLink to="/batch-alerts"><NavIcon>⚠</NavIcon><span className="nav-label">Batch safety</span></NavLink>
          {NAV_ITEMS.slice(5).map(([to, label, icon]) => <NavLink key={to} to={to}><NavIcon>{icon}</NavIcon><span className="nav-label">{t(label)}</span></NavLink>)}
          {user?.role === "ADMIN" && <>
            <div className="sidebar-section-label">Administration</div>
            <NavLink to="/admin"><NavIcon>⚙</NavIcon><span className="nav-label">{t("adminDashboard")}</span></NavLink>
            <NavLink to="/admin/categories"><NavIcon>▦</NavIcon><span className="nav-label">{t("globalCategories")}</span></NavLink>
            <NavLink to="/admin/rules"><NavIcon>✓</NavIcon><span className="nav-label">{t("complianceRules")}</span></NavLink>
          </>}
        </nav>
        <div className="sidebar-user"><strong>{user?.name || "User"}</strong><span>{user?.role || "USER"}</span><button type="button" onClick={logout}><span className="nav-icon" aria-hidden="true">↪</span>{t("signOut")}</button></div>
      </aside>
      <main className="main-content"><BatchWarningStrip /><Outlet />{location.pathname === "/scan" && <ScanVisualCheck />}</main>
    </div>
  </>;
}
export default Layout;
