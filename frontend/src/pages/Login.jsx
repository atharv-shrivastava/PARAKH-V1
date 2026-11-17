import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { saveSession } from "../lib/auth";
import { LANGUAGES } from "../lib/language";
import { getUserLanguagePreference } from "../lib/userLanguage";
import { useLanguage } from "../components/LanguageProvider";
import "../styles/auth.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { language, setLanguage, t } = useLanguage();

  async function submit(event) {
    event.preventDefault(); setLoading(true); setError("");
    try {
      const response = await fetch(`${API_URL}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Login failed");
      }
      saveSession(data.token, data.user);
      const savedUserLanguage = getUserLanguagePreference(data.user.id);
      setLanguage(savedUserLanguage || language);
      navigate(location.state?.from || "/", { replace: true });
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  return <div className="auth-page">
    <div className="auth-glow auth-glow-one" aria-hidden="true" />
    <div className="auth-glow auth-glow-two" aria-hidden="true" />
    <div className="auth-card">
      <div className="auth-card-topline"><p className="eyebrow">{t("parakh")}</p><span className="auth-orb" aria-hidden="true">P</span></div>
      <h1>{t("signIn")}</h1>
      <p>{t("signInSubtitle")}</p>
      <div className="language-picker language-picker-login">
        <label htmlFor="login-language">{t("chooseLanguage")}</label>
        <select id="login-language" value={language} onChange={(e) => setLanguage(e.target.value)} aria-label={t("chooseLanguage")}>
          {LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.nativeName} · {item.name}</option>)}
        </select>
      </div>
      <form onSubmit={submit}>
        <label>{t("email")}<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>{t("password")}<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <div className="auth-inline-link"><Link to={email ? `/forgot-password?email=${encodeURIComponent(email.trim().toLowerCase())}` : "/forgot-password"}>Forgot password?</Link></div>
        {error && <div className="status-message">{error}</div>}
        <button className="primary-button" disabled={loading}>{loading ? t("signingIn") : t("signIn")}</button>
      </form>
      <p>{t("newUser")} <Link to="/register">{t("createAccount")}</Link></p>
    </div>
  </div>;
}
export default Login;
