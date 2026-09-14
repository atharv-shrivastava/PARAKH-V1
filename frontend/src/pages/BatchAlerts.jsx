import { useCallback, useEffect, useState } from "react";
import { apiFetch, getUser } from "../lib/auth";
import "../styles/compliance-intelligence.css";

const API_URL = "http://localhost:5000/api";

export default function BatchAlerts() {
  const user = getUser();
  const [form, setForm] = useState({ productId: "", batchNumber: "", title: "", description: "", severity: "HIGH", evidenceUrl: "", inspectionId: "" });
  const [myReports, setMyReports] = useState([]); const [reports, setReports] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const isAdmin = String(user?.role || "").toUpperCase() === "ADMIN";

  const load = useCallback(async () => {
    setError("");
    try {
      const [alertResponse, mineResponse] = await Promise.all([
        apiFetch(`${API_URL}/batch-alerts?limit=50`),
        apiFetch(`${API_URL}/batch-alerts/incidents?scope=mine&status=REPORTED`),
      ]);
      const alertData = await alertResponse.json().catch(() => ({})); const mineData = await mineResponse.json().catch(() => ({}));
      if (!alertResponse.ok) throw new Error(alertData.error || "Could not load batch alerts");
      setAlerts(alertData.alerts || []); if (mineResponse.ok) setMyReports(mineData.reports || []);
      if (isAdmin) {
        const reportResponse = await apiFetch(`${API_URL}/batch-alerts/incidents?status=REPORTED`);
        const reportData = await reportResponse.json().catch(() => ({}));
        if (reportResponse.ok) setReports(reportData.reports || []);
      }
    } catch (e) { setError(e?.message || "Could not load batch alerts"); }
  }, [isAdmin]);

  useEffect(() => { load(); }, [load]);

  async function submitIncident(event) {
    event.preventDefault(); setMessage(""); setError("");
    try {
      const response = await apiFetch(`${API_URL}/batch-alerts/incidents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not report batch incident");
      setMessage(isAdmin ? "Incident verified and batch alert activated." : "Incident submitted for administrative verification.");
      setForm({ productId: "", batchNumber: "", title: "", description: "", severity: "HIGH", evidenceUrl: "", inspectionId: "" }); await load();
    } catch (e) { setError(e?.message || "Could not report batch incident"); }
  }

  async function verifyIncident(id) {
    setMessage(""); setError("");
    try {
      const response = await apiFetch(`${API_URL}/batch-alerts/incidents/${id}/verify`, { method: "PATCH" }); const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not verify incident");
      setMessage("Batch alert verified and made visible across PARAKH."); await load();
    } catch (e) { setError(e?.message || "Could not verify incident"); }
  }

  return <main className="intel-page">
    <header className="intel-hero"><div><p className="intel-kicker">PARAKH · BATCH SAFETY NETWORK</p><h1>Batch safety network</h1><p>State-wide verified batch alerts are shared across PARAKH, while every officer also keeps a separate record of their own reported batch incidents.</p></div><div className="intel-scope">STATE-WIDE + PERSONAL</div></header>
    {(message || error) && <div className={message ? "intel-success" : "intel-error"}>{message || error}</div>}

    <section className="intel-grid">
      <form className="intel-card" onSubmit={submitIncident}><div className="intel-section-head"><div><p className="intel-kicker">YOUR PERSONAL REPORT</p><h2>Report a batch incident</h2><p>This report belongs to your account until an administrator verifies it into the state-wide safety network.</p></div><div className="intel-scope personal">PERSONAL VIEW</div></div>
        {[['productId','Product ID'],['batchNumber','Batch number'],['title','Incident title'],['evidenceUrl','Evidence URL'],['inspectionId','Inspection ID (optional)']].map(([key,label]) => <label className="intel-form-field" key={key}><span>{label}</span><input value={form[key]} onChange={(e) => setForm((current) => ({ ...current, [key]: e.target.value }))} required={['productId','batchNumber'].includes(key)} /></label>)}
        <label className="intel-form-field"><span>Severity</span><select value={form.severity} onChange={(e) => setForm((current) => ({ ...current, severity: e.target.value }))}><option>HIGH</option><option>CRITICAL</option><option>MEDIUM</option></select></label>
        <label className="intel-form-field"><span>What was found?</span><textarea value={form.description} onChange={(e) => setForm((current) => ({ ...current, description: e.target.value }))} required placeholder="Describe the verified evidence or suspected serious incident." /></label>
        <button className="intel-primary-button" type="submit">Submit batch incident</button>
      </form>

      <section className="intel-card"><div className="intel-section-head"><div><p className="intel-kicker">STATE-WIDE ACTIVE WARNINGS</p><h2>Verified batch alerts</h2><p>These alerts are verified and visible across PARAKH.</p></div><div className="intel-scope">STATE-WIDE</div></div>{alerts.map((alert) => <div className={`intel-alert ${String(alert.severity || "HIGH").toLowerCase()}`} key={alert.id}><div><strong>⚠ {alert.product?.productName || "Product"} · Batch {alert.batchNumber}</strong><p>{alert.message}</p><small>{alert.product?.manufacturerName || alert.product?.brandName || "Manufacturer not recorded"}</small></div><span>{alert.severity}</span></div>)}{!alerts.length && <div className="intel-empty">No active state-wide batch alerts.</div>}</section>
    </section>

    <section className="intel-card"><div className="intel-section-head"><div><p className="intel-kicker">YOUR PERSONAL HISTORY</p><h2>My reported batch incidents</h2><p>Only incidents submitted from your account are shown here.</p></div><div className="intel-scope personal">PERSONAL VIEW</div></div>{myReports.map((report) => <div className="intel-report-row" key={report.id}><div><strong>{report.title}</strong><p>{report.product?.productName || "Product"} · Batch {report.batchNumber}</p><small>{report.description}</small><span>Status: {report.status} · Reported: {report.createdAt ? new Date(report.createdAt).toLocaleString() : "Not recorded"}</span></div>{isAdmin && report.status === "REPORTED" && <button type="button" className="intel-primary-button" onClick={() => verifyIncident(report.id)}>Verify &amp; alert</button>}</div>)}{!myReports.length && <div className="intel-empty">You have not reported any batch incidents yet.</div>}</section>

    {isAdmin && <section className="intel-card"><div className="intel-section-head"><div><p className="intel-kicker">ADMIN REVIEW QUEUE</p><h2>All incidents awaiting verification</h2><p>Administrative queue for converting personal reports into state-wide verified alerts.</p></div><div className="intel-scope">STATE-WIDE</div></div>{reports.map((report) => <div className="intel-report-row" key={`admin-${report.id}`}><div><strong>{report.title}</strong><p>{report.product?.productName || "Product"} · Batch {report.batchNumber}</p><small>{report.description}</small><span>{report.reportedBy?.name || "Officer"} · {report.inspection?.shop?.city || "Location not recorded"}</span></div><button type="button" className="intel-primary-button" onClick={() => verifyIncident(report.id)}>Verify &amp; alert</button></div>)}{!reports.length && <div className="intel-empty">No pending state-wide verification queue.</div>}</section>}
  </main>;
}
