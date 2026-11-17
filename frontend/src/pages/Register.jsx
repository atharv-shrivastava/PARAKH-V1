import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { saveSession } from "../lib/auth";
import "../styles/auth.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

function Register() {
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function submit(event) {
    event.preventDefault(); setError("");
    if (form.password !== form.confirm) return setError("Passwords do not match");
    setLoading(true);
    try {
      const created = await fetch(`${API_URL}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name, email: form.email, password: form.password }) });
      const data = await created.json();
      if (!created.ok) throw new Error(data.error || "Registration failed");
      saveSession(data.token, data.user);
      navigate("/", { replace: true });
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  return <div className="auth-page"><div className="auth-card"><p className="eyebrow">PARAKH</p><h1>Create account</h1><p>Create your account and start using PARAKH.</p><form onSubmit={submit}><label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>Email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label>Password<input required minLength="6" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label><label>Confirm password<input required type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} /></label>{error && <div className="status-message">{error}</div>}<button className="primary-button" disabled={loading}>{loading ? "Creating account…" : "Create account"}</button></form><p>Already registered? <Link to="/login">Sign in</Link></p></div></div>;
}
export default Register;
