import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { clearSession, getUser } from "../lib/auth";
import { applyTheme, getTheme, THEMES } from "../lib/theme";
import { LANGUAGES } from "../lib/language";
import { useLanguage } from "../components/LanguageProvider";
import "../styles/profile.css";

const THEME_GROUPS = [
  { id: "light", label: "Light", icon: "☀", ids: ["red", "blue", "green"] },
  { id: "dark", label: "Dark", icon: "◐", ids: ["dark-red", "dark-blue", "dark-green"] },
];

function ThemeIcon({ kind }) {
  return <span className={`theme-group-icon ${kind}`} aria-hidden="true" />;
}

function Profile() {
  const navigate = useNavigate();
  const [user] = useState(getUser());
  const [theme, setTheme] = useState(getTheme());
  const { language, setLanguage, t } = useLanguage();

  function logout() {
    clearSession();
    navigate("/login", { replace: true });
  }

  function changeTheme(event) {
    setTheme(applyTheme(event.target.value));
  }

  function changeLanguage(event) {
    setLanguage(event.target.value);
  }

  return <div className="profile-page">
    <div className="page-header"><p className="eyebrow">{t("account")}</p><h1>{t("profileSettings")}</h1><p>{t("profileSubtitle")}</p></div>
    <section className="profile-card">
      <div><span>{t("name")}</span><strong>{user?.name || "User"}</strong></div>
      <div><span>{t("email")}</span><strong>{user?.email || "Not available"}</strong></div>
      <div><span>{t("role")}</span><strong>{user?.role || "USER"}</strong></div>
      <div className="language-settings">
        <div><h2>{t("language")}</h2><p>{t("languageHelp")}</p></div>
        <select className="language-select" value={language} onChange={changeLanguage} aria-label={t("chooseLanguage")}>
          {LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.nativeName} · {item.name}</option>)}
        </select>
      </div>
      <div className="theme-settings">
        <div className="theme-settings-heading"><div><h2>{t("setTheme")}</h2><p>{t("themeHelp")}</p></div><span className="theme-current-badge">{THEMES.find((item) => item.id === theme)?.name || theme}</span></div>
        <select className="theme-select" value={theme} onChange={changeTheme} aria-label="Application theme">
          {THEME_GROUPS.map((group) => <optgroup key={group.id} label={group.label}>{THEMES.filter((item) => group.ids.includes(item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>)}
        </select>
        <div className="theme-groups">
          {THEME_GROUPS.map((group) => {
            const items = THEMES.filter((item) => group.ids.includes(item.id));
            return <div className={`theme-group theme-group-${group.id}`} key={group.id}>
              <div className="theme-group-heading"><ThemeIcon kind={group.id} /><div><strong>{group.label}</strong><span>{items.length} themes</span></div></div>
              <div className="theme-grid">
                {items.map((item) => <button key={item.id} type="button" className={`theme-tile ${theme === item.id ? "active" : ""} theme-tile-${item.id}`} style={{ "--theme-chip": item.primary }} title={item.name} aria-label={`Use ${item.name} theme`} onClick={() => { setTheme(applyTheme(item.id)); }}>
                  <span className="theme-tile-preview" />
                  <span className="theme-tile-name">{item.name}</span>
                  {theme === item.id && <span className="theme-check" aria-hidden="true">✓</span>}
                </button>)}
              </div>
            </div>;
          })}
        </div>
      </div>
      <button className="secondary-action" type="button" onClick={logout}>{t("signOut")}</button>
    </section>
  </div>;
}

export default Profile;
