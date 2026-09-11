import { useCallback, useEffect, useState } from "react";
import { apiFetch, getUser } from "../lib/auth";
import "../styles/compliance-intelligence.css";

const API_URL = "http://localhost:5000/api";

export default function BatchAlerts() {
  const user = getUser();
  const [form, setForm] = useState({ productId: "", batchNumber: "", title: "", description: "", severity: "HIGH", evidenceUrl: "", inspectionId: "" });
  const [reports, setReports] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const alertResponse = await apiFetch(`${API_URL}/batch-alerts?limit=50`);
      const alertData = await alertResponse.json().catch(() => ({}));
      if (!alertResponse.ok) throw new Error(alertData.error || "Could not load batch alerts");
      setAlerts(alertData.alerts || []);
      if (String(user?.role || "").toUpperCase() === "ADMIN") {
        const reportResponse = await apiFetch(`${API_URL}/batch-alerts/incidents?status=REPORTED`);
        const reportData = await reportResponse.json().catch(() => ({}));
        if (reportResponse.ok) setReports(reportData.reports || []);
      }
    } catch (e) {
      setError(e?.message || "Could not load batch alerts");
    }
  }, [user?.role]);

  useEffect(() => { load(); }, [load]);

  async function submitIncident(event) {
    event.preventDefault();
    setMessage(""); setError("");
    try {
      const response = await apiFetch(`${API_URL}/batch-alerts/incidents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not report batch incident");
      setMessage(String(user?.role || "").toUpperCase() === "ADMIN" ? "Incident verified and batch alert activated." : "Incident submitted for administrative verification.");
      setForm({ productId: "", batchNumber: "", title: "", description: "", severity: "HIGH", evidenceUrl: "", inspectionId: "" });
      await load();
    } catch (e) {
      setError(e?.message || "Could not report batch incident");
    }
  }

  async function verifyIncident(id) {
    setMessage(""); setError("");
    try {
      const response = await apiFetch(`${API_URL}/batch-alerts/incidents/${id}/verify`, { method: "PATCH" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not verify incident");
      setMessage("Batch alert verified and made visible across PARAKH.");
      await load();
    } catch (e) {
      setError(e?.message || "Could not verify incident");
    }
  }

  return <main className="intel-page">
    <header className="intel-hero"><div><p className="intel-kicker">PARAKH · BATCH SAFETY NETWORK</p><h1>Batch incident and alert workflow</h1><p>A serious incident is reported against a batch, reviewed by an authorized admin, and then propagated as a verified in-app warning.</p></div></header>
    {(message || error) && <div className={message ? "intel-success" : "intel-error"}>{message || error}</div>}

    <section className="intel-grid">
      <form className="intel-card" onSubmit={submitIncident}><div className="intel-section-head"><div><p className="intel-kicker">FIELD REPORT</p><h2>Report a batch incident</h2><p>Use the product ID from the registered product record. Batch number must match the package.</p></div></div>
        {[['productId','Product ID'],['batchNumber','Batch number'],['title','Incident title'],['evidenceUrl','Evidence URL'],['inspectionId','Inspection ID (optional)']].map(([key,label]) => <label className="intel-form-field" key={key}><span>{label}</span><input value={form[key]} onChange={(e) => setForm((current) => ({ ...current, [key]: e.target.value }))} required={['productId','batchNumber'].includes(key)} /></label>)}
        <label className="intel-form-field"><span>Severity</span><select value={form.severity} onChange={(e) => setForm((current) => ({ ...current, severity: e.target.value }))}><option>HIGH</option><option>CRITICAL</option><option>MEDIUM</option></select></label>
        <label className="intel-form-field"><span>What was found?</span><textarea value={form.description} onChange={(e) => setForm((current) => ({ ...current, description: e.target.value }))} required placeholder="Describe the verified evidence or suspected serious incident." /></label>
        <button className="intel-primary-button" type="submit">Submit batch incident</button>
      </form>

      <section className="intel-card"><div className="intel-section-head"><div><p className="intel-kicker">ACTIVE WARNINGS</p><h2>Verified batch alerts</h2></div></div>{alerts.map((alert) => <div className={`intel-alert ${String(alert.severity || "HIGH").toLowerCase()}`} key={alert.id}><div><strong>⚠ {alert.product?.productName || "Product"} · Batch {alert.batchNumber}</strong><p>{alert.message}</p><small>{alert.product?.manufacturerName || alert.product?.brandName || "Manufacturer not recorded"}</small></div><span>{alert.severity}</span></div>)}{!alerts.length && <div className="intel-empty">No active batch alerts.</div>}</section>
    </section>

    {String(user?.role || "").toUpperCase() === "ADMIN" && <section className="intel-card"><div className="intel-section-head"><div><p className="intel-kicker">ADMIN REVIEW QUEUE</p><h2>Incidents awaiting verification</h2></div></div>{reports.map((report) => <div className="intel-report-row" key={report.id}><div><strong>{report.title}</strong><p>{report.product?.productName || "Product"} · Batch {report.batchNumber}</p><small>{report.description}</small><span>{report.reportedBy?.name || "Officer"} · {report.inspection?.shop?.city || "Location not recorded"}</span></div><button type="button" className="intel-primary-button" onClick={() => verifyIncident(report.id)}>Verify &amp; alert</button></div>)}{!reports.length && <div className="intel-empty">No pending batch incidents.</div>}</section>}
  </main>;
}
