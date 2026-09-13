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

  return <div className="app-layout">
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
    <main className="main-content pl-0 md:ml-60 md:pl-0">
      <BatchWarningStrip />
      <Outlet />
      {location.pathname === "/scan" && <ScanVisualCheck />}
    </main>
  </div>;
}
export default Layout;
