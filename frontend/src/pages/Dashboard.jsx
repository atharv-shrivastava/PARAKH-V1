import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, getUser } from "../lib/auth";
import { useLanguage } from "../components/LanguageProvider";
import "../styles/dashboard.css";

const API_URL = "http://localhost:5000/api";
const ANALYTICS_CACHE_KEY = "parakh_dashboard_analytics";
const DASHBOARD_REFRESH_MS = 5000;

function StatCard({ label, value, tone = "neutral", detail }) {
  return <div className={`user-stat-card ${tone}`}>
    <span>{label}</span>
    <strong>{value ?? 0}</strong>
    {detail && <small>{detail}</small>}
  </div>;
}

function IntelligenceCard({ label, value, empty }) {
  return <div className="inspection-intel-card">
    <p>{label}</p>
    <strong>{value?.name || empty}</strong>
    <span>{value ? `${value.count} violation${Number(value.count) === 1 ? "" : "s"}` : "0 violations"}</span>
  </div>;
}

function LiveInspectionIntelligence({ data, loading }) {
  const counts = data?.counts || {};
  const trend = data?.inspectionTrend || [];

  const formatMonth = (value) => {
    const date = new Date(`${value}-01T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-US", { month: "short" });
  };

  const maxInspections = Math.max(...trend.map((item) => Number(item.inspections || 0)), 1);

  return <section className="inspection-intelligence">
    <div className="inspection-intelligence-header">
      <div>
        <p className="card-kicker">LIVE INSPECTION INTELLIGENCE</p>
        <h2>Your inspection signals</h2>
        <p>Derived directly from recorded inspections, products and rule findings. No placeholder statistics.</p>
      </div>
      {data?.scope && <span className="inspection-scope">{data.scope === "PLATFORM" ? "PLATFORM DATA" : "YOUR DATA"}</span>}
    </div>

    <div className="inspection-intelligence-counts">
      <div><span>INSPECTIONS</span><strong>{loading ? "Updating…" : Number(counts.inspections || 0)}</strong></div>
      <div><span>VIOLATIONS</span><strong className="danger-text">{loading ? "Updating…" : Number(counts.violations || 0)}</strong></div>
    </div>

    <div className="inspection-intelligence-volume">
      <div className="inspection-intelligence-subhead">
        <div><span className="card-kicker">INSPECTION VOLUME</span><h3>Last 12 months</h3></div>
        <span>{loading ? "Updating…" : "Live from recorded inspections"}</span>
      </div>
      <div className="inspection-chart" aria-label="Inspections over the last 12 months">
        {trend.map((item) => <div className="inspection-chart-item" key={item.month}>
          <div className="inspection-chart-track"><i style={{ height: `${Math.max(item.inspections ? 8 : 2, (Number(item.inspections || 0) / maxInspections) * 100)}%` }} /></div>
          <b>{Number(item.inspections || 0)}</b>
          <span>{formatMonth(item.month)}</span>
        </div>)}
        {!trend.length && <div className="inspection-chart-empty">{loading ? "Updating…" : "No recorded inspections yet"}</div>}
      </div>
      <p className="inspection-chart-caption">Inspections over the last 12 months</p>
    </div>

    <div className="inspection-intelligence-grid">
      <IntelligenceCard label="HIGHEST VIOLATING SHOP / SOURCE" value={data?.highestViolatingShop} empty="No violating shop yet" />
      <IntelligenceCard label="HIGHEST VIOLATING BRAND" value={data?.highestViolatingBrand} empty="No violating brand yet" />
      <IntelligenceCard label="HIGHEST VIOLATING RULE" value={data?.highestViolatingRule} empty="No violating rule yet" />
      <IntelligenceCard label="MOST VIOLATIONS" value={data?.highestViolatingRule} empty="No violation pattern yet" />
    </div>
  </section>;
}

export default function Dashboard() {
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");
  const [analytics, setAnalytics] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(ANALYTICS_CACHE_KEY) || "null"); } catch { return null; }
  });
  const [inspectionIntel, setInspectionIntel] = useState(null);
  const [inspectionIntelLoading, setInspectionIntelLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const user = getUser();
  const { t } = useLanguage();

  const refreshDashboard = useCallback(async ({ initial = false } = {}) => {
    if (initial) {
      setLoading(true);
      setInspectionIntelLoading(true);
    }

    const results = await Promise.allSettled([
      apiFetch(`${API_URL}/products?limit=6`),
      apiFetch(`${API_URL}/products/analytics/summary`),
      apiFetch(`${API_URL}/analytics/dashboard`),
    ]);

    const [historyResult, analyticsResult, inspectionResult] = results;

    if (historyResult.status === "fulfilled") {
      try {
        const data = await historyResult.value.json();
        if (historyResult.value.ok) setHistory(Array.isArray(data) ? data.slice(0, 6) : []);
        else if (initial) setError(data?.error || "Could not load recent products");
      } catch (e) {
        if (initial) setError(e?.message || "Could not load recent products");
      }
    } else if (initial) {
      setError(historyResult.reason?.message || "Could not load recent products");
    }

    if (analyticsResult.status === "fulfilled") {
      try {
        const data = await analyticsResult.value.json().catch(() => ({}));
        if (analyticsResult.value.ok) {
          setAnalytics(data);
          try { sessionStorage.setItem(ANALYTICS_CACHE_KEY, JSON.stringify(data)); } catch {}
        } else if (initial) {
          setError(data?.error || "Could not load analytics");
        }
      } catch (e) {
        if (initial) setError(e?.message || "Could not load analytics");
      }
    } else if (initial) {
      setError(analyticsResult.reason?.message || "Could not load analytics");
    }

    if (inspectionResult.status === "fulfilled") {
      try {
        const data = await inspectionResult.value.json().catch(() => ({}));
        if (inspectionResult.value.ok) {
          setInspectionIntel(data);
        } else if (initial) {
          setError((current) => current || data?.error || "Could not load inspection intelligence");
        }
      } catch (e) {
        if (initial) setError((current) => current || e?.message || "Could not load inspection intelligence");
      }
    } else if (initial) {
      setError((current) => current || inspectionResult.reason?.message || "Could not load inspection intelligence");
    }

    if (initial) {
      setLoading(false);
      setInspectionIntelLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => { if (active) refreshDashboard({ initial: false }); };

    refreshDashboard({ initial: true });

    const interval = window.setInterval(refresh, DASHBOARD_REFRESH_MS);
    const onVisibilityChange = () => { if (document.visibilityState === "visible") refresh(); };
    const onDataUpdated = () => refresh();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("parakh:data-updated", onDataUpdated);

    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("parakh:data-updated", onDataUpdated);
    };
  }, [refreshDashboard]);

  const counts = analytics?.counts || {};
  const total = Number(counts.products ?? 0);
  const compliant = Number(counts.compliant ?? 0);
  const violations = Number(counts.violations ?? 0);
  const review = Number(counts.review ?? 0);
  const complianceRate = total ? Math.round((compliant / total) * 100) : 0;
  const topRules = analytics?.topRules || [];
  const topCategories = analytics?.topCategories || [];

  if (loading && !history.length) return <main className="dashboard dashboard-modern"><div className="dashboard-loading"><div className="loading-orb" /><h2>Loading your PARAKH workspace</h2><p>Fetching recent inspections.</p></div></main>;

  return <main className="dashboard dashboard-modern">
    <header className="dashboard-hero">
      <div className="dashboard-hero-copy"><p className="eyebrow">PARAKH · INSPECTION WORKSPACE</p><h1>{t("welcome")}, {user?.name || "Inspector"}.</h1><p>{t("inspectSubtitle")}</p></div>
      <div className="dashboard-hero-actions"><Link className="dashboard-primary-action" to="/scan"><span>＋</span> New scan</Link><Link className="dashboard-secondary-action" to="/products/manual-register">Manual registration</Link></div>
    </header>
    {error && <div className="dashboard-alert">{error}</div>}

    <LiveInspectionIntelligence data={inspectionIntel} loading={inspectionIntelLoading} />

    <section className="dashboard-stat-grid">
      <StatCard label={t("totalRegistered")} value={total} detail={analytics ? "Registered products" : "Loading…"} />
      <StatCard label={t("compliant")} value={analytics ? compliant : "—"} tone="success" detail={analytics ? `${complianceRate}% of registered products` : "Fetching compliance"} />
      <StatCard label={t("violations")} value={analytics ? violations : "—"} tone="danger" detail="Recorded violations" />
      <StatCard label={t("needsReview")} value={analytics ? review : "—"} tone="warning" detail="Require officer review" />
    </section>

    <section className="dashboard-workspace-grid">
      <div className="dashboard-feature-card dashboard-inspection-card"><div className="dashboard-feature-glow" /><div className="dashboard-feature-icon">⌁</div><p className="card-kicker">PRODUCT INSPECTION</p><h2>Scan a package and verify its declarations.</h2><p>Use OCR, semantic field mapping and the Legal Metrology Rules Engine while keeping the existing product hierarchy intact.</p><Link className="dashboard-feature-link" to="/scan">Start inspection <span>→</span></Link></div>
      <div className="dashboard-module-card hierarchy-card"><div className="module-heading"><div><p className="card-kicker">PRODUCT HIERARCHY</p><h2>Categories stay in control.</h2></div><Link to="/products">Open</Link></div><div className="hierarchy-visual"><div><span>MAIN CATEGORY</span><b>↓</b></div><div><span>SUBCATEGORY</span><b>↓</b></div><div className="hierarchy-final"><span>FINAL PRODUCT TYPE</span><strong>REGISTER PRODUCTS</strong></div></div><p>Browse offline and e-commerce categories, drill into subcategories and register products only under final product types.</p></div>
    </section>

    <section className="dashboard-section"><div className="dashboard-section-heading"><div><p className="card-kicker">RECENT ACTIVITY</p><h2>Latest inspections</h2></div><Link to="/history">View full history →</Link></div><div className="dashboard-inspection-list">{history.map((product, index) => { const inspection = product.inspections?.[0]; const status = product.complianceStatus || "NEEDS_REVIEW"; const source = String(product.sourceType || "OFFLINE").toUpperCase(); return <Link key={product.id} to={`/products/item/${product.id}`} className="dashboard-inspection-row"><div className="inspection-index">{String(index + 1).padStart(2, "0")}</div><div className="inspection-main"><strong>{product.productName}</strong><span>{product.brandName || "Company not recorded"} · {product.category?.name || "Uncategorised"}</span></div><div className="inspection-source"><span>{source === "ECOMMERCE" ? "E-COMMERCE" : "OFFLINE"}</span><small>{source === "ECOMMERCE" ? (product.sourceWebsiteName || "Website") : (inspection?.shop?.name || "Shop not recorded")}</small></div><span className={`dashboard-status ${status === "OKAY" ? "compliant" : status === "VIOLATION" ? "violation" : "review"}`}>{status.replaceAll("_", " ")}</span></Link>; })}{!history.length && <div className="dashboard-empty">No inspections have been registered yet.</div>}</div></section>

    <section className="dashboard-bottom-grid">
      <div className="dashboard-module-card"><div className="module-heading"><div><p className="card-kicker">COMPLIANCE SIGNALS</p><h2>Frequent rule violations</h2></div><Link to="/reports">Reports</Link></div>{analytics ? (topRules.length ? <div className="dashboard-bars">{topRules.slice(0, 5).map((item) => { const max = Math.max(...topRules.map((x) => Number(x.count || 0)), 1); return <div className="dashboard-bar-row" key={item.rule}><div><span>{item.rule}</span><b>{item.count}</b></div><i><em style={{ width: `${Math.max(7, (Number(item.count || 0) / max) * 100)}%` }} /></i></div>; })}</div> : <p className="dashboard-muted">No violation pattern has emerged yet.</p>) : <p className="dashboard-muted">Loading compliance signals…</p>}</div>
      <div className="dashboard-module-card"><div className="module-heading"><div><p className="card-kicker">CATEGORY DISTRIBUTION</p><h2>Most inspected categories</h2></div><Link to="/products">Browse</Link></div>{analytics ? (topCategories.length ? <div className="dashboard-category-list">{topCategories.slice(0, 6).map((item, index) => <Link key={item.categoryId || index} to={`/products/category/${item.categoryId}`} className="dashboard-category-row"><span className="category-rank">{index + 1}</span><span>{item.name}</span><b>{item.products}</b></Link>)}</div> : <p className="dashboard-muted">No category data yet.</p>) : <p className="dashboard-muted">Loading category data…</p>}</div>
    </section>

    <section className="dashboard-quick-links"><Link to="/products"><span>01</span><div><strong>Products & hierarchy</strong><small>Manage categories and registered records</small></div><b>→</b></Link><Link to="/shops"><span>02</span><div><strong>Inspection sources</strong><small>Browse registered shops and sources</small></div><b>→</b></Link><Link to="/reports"><span>03</span><div><strong>Compliance reports</strong><small>Generate evidence-backed reports</small></div><b>→</b></Link><Link to="/ecommerce-inspection"><span>04</span><div><strong>E-commerce inspection</strong><small>Inspect online product listings</small></div><b>→</b></Link></section>
  </main>;
}
