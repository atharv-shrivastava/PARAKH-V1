import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/auth";
import "../styles/admin-dashboard.css";
import "../styles/admin-dashboard-modern.css";

const API_URL = "http://localhost:5000/api";

function Stat({ label, value, helper }) {
  return <div className="admin-stat-card"><span>{label}</span><strong>{value ?? 0}</strong><small>{helper}</small></div>;
}

export default function AdminDashboard() {
  const [data, setData] = useState(null);
  const [dashboardIntel, setDashboardIntel] = useState(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [overviewResponse, reportsResponse, intelResponse] = await Promise.all([
        apiFetch(`${API_URL}/admin/overview`),
        apiFetch(`${API_URL}/batch-alerts/incidents?status=REPORTED`),
        apiFetch(`${API_URL}/analytics/dashboard`),
      ]);
      const overview = await overviewResponse.json().catch(() => ({}));
      const reports = await reportsResponse.json().catch(() => ({}));
      const intel = await intelResponse.json().catch(() => ({}));
      if (!overviewResponse.ok) throw new Error(overview.error || "Could not load admin control center");
      if (!intelResponse.ok) throw new Error(intel.error || "Could not load violation intelligence");
      setData(overview);
      setDashboardIntel(intel);
      setPending(Array.isArray(reports.reports) ? reports.reports.length : 0);
    } catch (e) {
      setError(e?.message || "Could not load admin control center");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <main className="admin-dashboard admin-dashboard-modern"><div className="admin-loading"><div className="admin-loading-orb" /><h2>Loading PARAKH control center</h2><p>Preparing administrative operations.</p></div></main>;
  if (error) return <main className="admin-dashboard admin-dashboard-modern"><div className="admin-error">{error}<button type="button" className="admin-retry" onClick={load}>Retry</button></div></main>;

  const counts = data?.counts || {};
  const recent = data?.recentInspections || [];
  const mostViolations = dashboardIntel?.highestViolatingRule || null;
  return <main className="admin-dashboard admin-dashboard-modern">
    <header className="admin-hero"><div><p className="card-kicker">PARAKH · ADMIN CONTROL CENTER</p><h1>Operate the system, verify the evidence.</h1><p>State-wide intelligence now lives in the shared Compliance Intelligence view. This dashboard is reserved for administration, verification and operational controls.</p></div><div className="admin-hero-actions"><button type="button" className="admin-secondary" onClick={load}>Refresh data</button><Link className="admin-primary" to="/intelligence">Open intelligence</Link></div></header>
    <section className="admin-stat-grid">
      <Stat label="Users" value={counts.users} helper="Registered accounts" />
      <Stat label="Products" value={counts.products} helper="Stored product records" />
      <Stat label="Inspections" value={counts.inspections} helper="Recorded checks" />
      <Stat label="Violations" value={counts.violations} helper="Recorded non-compliance" />
      <Stat label="Most violations" value={mostViolations?.name || "None yet"} helper={mostViolations ? `${mostViolations.count} recorded occurrences` : "No violation pattern yet"} />
      <Stat label="Needs review" value={counts.review} helper="Awaiting verification" />
      <Stat label="Batch reports" value={pending} helper="Awaiting alert verification" />
    </section>

    <section className="admin-command-grid">
      <Link className="admin-command primary" to="/batch-alerts"><span>01</span><div><small>SAFETY</small><strong>Batch incident queue</strong><em>Review incidents and activate verified batch alerts</em></div><b>→</b></Link>
      <Link className="admin-command" to="/admin/categories"><span>02</span><div><small>STRUCTURE</small><strong>Product hierarchy</strong><em>Manage global category structure</em></div><b>→</b></Link>
      <Link className="admin-command" to="/admin/rules"><span>03</span><div><small>RULES</small><strong>Compliance rules</strong><em>Create and manage rule definitions</em></div><b>→</b></Link>
      <Link className="admin-command" to="/intelligence"><span>04</span><div><small>ANALYTICS</small><strong>Compliance intelligence</strong><em>Filter and drill into state-wide patterns</em></div><b>→</b></Link>
    </section>

    <section className="admin-panel"><div className="admin-panel-head"><div><p className="card-kicker">LIVE ACTIVITY</p><h2>Recent inspections</h2><p>Operational records requiring visibility, without duplicating the intelligence graphs.</p></div><Link to="/history">History →</Link></div><div className="admin-list">{recent.slice(0, 12).map((x) => { const ecommerce = String(x.sourceType || "OFFLINE").toUpperCase() === "ECOMMERCE"; const source = ecommerce ? (x.sourceWebsiteName || x.sourceUrl || "E-commerce source") : (x.shop?.name || "Unknown shop"); return <Link className="admin-list-row" to={x.product?.id ? `/products/item/${x.product.id}` : "/history"} key={x.id}><div><strong>{x.product?.productName || "Unnamed product"}</strong><span>{ecommerce ? "E-COMMERCE" : "OFFLINE"} · {source} · {x.worker?.name || "Unknown user"}</span><small>{x.inspectedAt ? new Date(x.inspectedAt).toLocaleString() : "Date unavailable"}</small></div><b className={`admin-status-pill ${(x.status || "NEEDS_REVIEW").toLowerCase()}`}>{String(x.status || "NEEDS_REVIEW").replaceAll("_", " ")}</b></Link>; })}{!recent.length && <p className="admin-empty">No inspections yet.</p>}</div></section>
  </main>;
}
