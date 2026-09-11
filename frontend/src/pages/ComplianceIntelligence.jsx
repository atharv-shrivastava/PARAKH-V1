import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, getUser } from "../lib/auth";
import "../styles/compliance-intelligence.css";

const API_URL = "http://localhost:5000/api";
const FILTERS = [
  ["manufacturer", "Manufacturer"],
  ["product", "Product"],
  ["gtin", "GTIN"],
  ["batch", "Batch number"],
  ["violation", "Violation type"],
  ["district", "City / district"],
  ["state", "State"],
];

function Metric({ label, value, helper }) {
  return <div className="intel-metric"><span>{label}</span><strong>{value ?? 0}</strong>{helper && <small>{helper}</small>}</div>;
}

function Bars({ items = [], labelKey, valueKey = "count", suffix = "" }) {
  const max = Math.max(...items.map((x) => Number(x?.[valueKey] || 0)), 1);
  if (!items.length) return <div className="intel-empty">No matching data yet.</div>;
  return <div className="intel-bars">{items.slice(0, 10).map((item, index) => {
    const value = Number(item?.[valueKey] || 0);
    return <div className="intel-bar-row" key={`${String(item?.[labelKey])}-${index}`}>
      <div className="intel-bar-label"><span>{item?.[labelKey] || "Unknown"}</span><b>{value}{suffix}</b></div>
      <div className="intel-bar-track"><i style={{ width: `${Math.max(4, (value / max) * 100)}%` }} /></div>
    </div>;
  })}</div>;
}

function buildQuery(filters, verified) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => { if (String(value || "").trim()) params.set(key, value); });
  if (verified) params.set("verified", "true");
  return params.toString();
}

export default function ComplianceIntelligence() {
  const user = getUser();
  const [filters, setFilters] = useState({ manufacturer: "", product: "", gtin: "", batch: "", violation: "", district: "", state: "", from: "", to: "" });
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [data, setData] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const query = buildQuery(filters, verifiedOnly);
      const [intelligenceResponse, alertResponse] = await Promise.all([
        apiFetch(`${API_URL}/analytics/intelligence?${query}`),
        apiFetch(`${API_URL}/batch-alerts?limit=20`),
      ]);
      const intelligence = await intelligenceResponse.json().catch(() => ({}));
      const alertData = await alertResponse.json().catch(() => ({}));
      if (!intelligenceResponse.ok) throw new Error(intelligence.error || "Could not load compliance intelligence");
      setData(intelligence);
      setAlerts(Array.isArray(alertData.alerts) ? alertData.alerts : []);
    } catch (e) {
      setError(e?.message || "Could not load compliance intelligence");
    } finally {
      setLoading(false);
    }
  }, [filters, verifiedOnly]);

  useEffect(() => { load(); }, [load]);

  const visibleManufacturerRows = useMemo(() => data?.manufacturerLeaderboard || [], [data]);

  return <main className="intel-page">
    <header className="intel-hero">
      <div>
        <p className="intel-kicker">PARAKH · COMPLIANCE INTELLIGENCE</p>
        <h1>State-wide compliance intelligence</h1>
        <p>Every recorded inspection becomes part of a connected view of manufacturers, products, batches, violations and geography.</p>
      </div>
      <div className="intel-scope">{user?.role === "ADMIN" ? "FULL STATE VIEW" : "STATE-WIDE READ VIEW"}</div>
    </header>

    <section className="intel-filter-panel">
      <div className="intel-filter-grid">
        {FILTERS.map(([key, label]) => <label key={key}><span>{label}</span><input value={filters[key]} onChange={(e) => setFilters((current) => ({ ...current, [key]: e.target.value }))} placeholder={`Filter by ${label.toLowerCase()}`} /></label>)}
        <label><span>From</span><input type="date" value={filters.from} onChange={(e) => setFilters((current) => ({ ...current, from: e.target.value }))} /></label>
        <label><span>To</span><input type="date" value={filters.to} onChange={(e) => setFilters((current) => ({ ...current, to: e.target.value }))} /></label>
      </div>
      <div className="intel-filter-actions">
        <label className="intel-toggle"><input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} /><span>Verified violations only</span></label>
        <button type="button" onClick={() => setFilters({ manufacturer: "", product: "", gtin: "", batch: "", violation: "", district: "", state: "", from: "", to: "" })}>Clear filters</button>
      </div>
    </section>

    {error && <div className="intel-error">{error}<button type="button" onClick={load}>Retry</button></div>}
    {loading && !data ? <div className="intel-loading">Loading connected compliance data…</div> : null}
    {data && <>
      <section className="intel-metrics">
        <Metric label="Inspections" value={data.counts?.inspections} />
        <Metric label="Recorded violations" value={data.counts?.recordedViolations} />
        <Metric label="Verified violations" value={data.counts?.verifiedViolations} />
        <Metric label="Affected batches" value={data.counts?.affectedBatches} />
        <Metric label="Violation rate" value={`${data.counts?.violationRate ?? 0}%`} />
      </section>

      {alerts.length > 0 && <section className="intel-alert-panel"><div className="intel-section-head"><div><p className="intel-kicker">ACTIVE SAFETY SIGNALS</p><h2>Verified batch alerts</h2></div></div><div className="intel-alert-list">{alerts.slice(0, 5).map((alert) => <div className={`intel-alert ${String(alert.severity || "HIGH").toLowerCase()}`} key={alert.id}><div><strong>⚠ {alert.product?.productName || "Product"} · Batch {alert.batchNumber}</strong><p>{alert.message}</p><small>{alert.product?.manufacturerName || alert.product?.brandName || "Manufacturer not recorded"}</small></div><span>{alert.severity}</span></div>)}</div></section>}

      <section className="intel-grid intel-grid-wide">
        <div className="intel-card"><div className="intel-section-head"><div><p className="intel-kicker">TREND</p><h2>Inspection trend</h2></div></div><Bars items={data.trend} labelKey="month" valueKey="inspections" /></div>
        <div className="intel-card"><div className="intel-section-head"><div><p className="intel-kicker">GEOGRAPHY</p><h2>Violations by district</h2></div></div><Bars items={data.districtViolations} labelKey="district" /></div>
      </section>

      <section className="intel-grid">
        <div className="intel-card"><div className="intel-section-head"><div><p className="intel-kicker">VIOLATION PATTERNS</p><h2>Violation types</h2></div></div><Bars items={data.violationTypes} labelKey="violation" /></div>
        <div className="intel-card"><div className="intel-section-head"><div><p className="intel-kicker">BATCH PATTERNS</p><h2>Affected batches</h2></div></div><Bars items={data.affectedBatches} labelKey="batch" /></div>
      </section>

      <section className="intel-card"><div className="intel-section-head"><div><p className="intel-kicker">MANUFACTURER COMPLIANCE</p><h2>Manufacturer analytics</h2><p>Use violation rate together with raw violation count. A manufacturer inspected more often will naturally accumulate more records.</p></div></div><div className="intel-table-wrap"><table className="intel-table"><thead><tr><th>Manufacturer</th><th>Inspections</th><th>Violations</th><th>Verified</th><th>Violation rate</th></tr></thead><tbody>{visibleManufacturerRows.map((row) => <tr key={row.manufacturer}><td>{row.manufacturer}</td><td>{row.inspections}</td><td>{row.violations}</td><td>{row.verifiedViolations}</td><td>{row.violationRate}%</td></tr>)}{!visibleManufacturerRows.length && <tr><td colSpan="5">No manufacturer data for the current filters.</td></tr>}</tbody></table></div></section>

      <section className="intel-grid">
        <div className="intel-card"><div className="intel-section-head"><div><p className="intel-kicker">PRODUCTS</p><h2>Products with violations</h2></div></div><Bars items={data.productViolations} labelKey="product" /></div>
        <div className="intel-card"><div className="intel-section-head"><div><p className="intel-kicker">SEVERITY</p><h2>Violation severity</h2></div></div><Bars items={data.severityBreakdown} labelKey="severity" /></div>
      </section>
    </>}
  </main>;
}
