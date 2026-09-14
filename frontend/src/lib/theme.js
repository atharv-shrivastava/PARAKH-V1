export const THEMES = [
  { id: "red", name: "Red", primary: "#dc2626", background: "#fff7f7", surface: "#ffffff", text: "#2b1212", muted: "#765f5f", border: "#f0d6d6", sidebar: "#4a1010", neonRgb: "220,38,38", input: "#ffffff" },
  { id: "blue", name: "Blue", primary: "#2563eb", background: "#f5f7fb", surface: "#ffffff", text: "#172033", muted: "#647084", border: "#e1e6ef", sidebar: "#111827", neonRgb: "37,99,235", input: "#ffffff" },
  { id: "green", name: "Green", primary: "#16a34a", background: "#f4fbf6", surface: "#ffffff", text: "#10231a", muted: "#607468", border: "#d9eadf", sidebar: "#0b3a20", neonRgb: "22,163,74", input: "#ffffff" },
  { id: "dark-red", name: "Dark Red", primary: "#991b1b", background: "#16090a", surface: "#211012", text: "#fff1f1", muted: "#c7a0a0", border: "#472124", sidebar: "#070304", neonRgb: "239,68,68", input: "#170d0f" },
  { id: "dark-blue", name: "Dark Blue", primary: "#1d4ed8", background: "#080f1d", surface: "#111b2e", text: "#eff6ff", muted: "#9eb0c9", border: "#263754", sidebar: "#030812", neonRgb: "59,130,246", input: "#0b1425" },
  { id: "dark-green", name: "Dark Green", primary: "#166534", background: "#07120b", surface: "#0d1d13", text: "#ecfdf5", muted: "#9ebaaa", border: "#1d3b29", sidebar: "#030b06", neonRgb: "34,197,94", input: "#09170f" },
];

const KEY = "parakh_theme";
export const DEFAULT_THEME = "blue";

export function getTheme() {
  const value = localStorage.getItem(KEY);
  return THEMES.some((theme) => theme.id === value) ? value : DEFAULT_THEME;
}

export function applyTheme(themeId) {
  const id = THEMES.some((theme) => theme.id === themeId) ? themeId : DEFAULT_THEME;
  const darkThemes = new Set(["dark-red", "dark-blue", "dark-green"]);
  const theme = THEMES.find((item) => item.id === id) || THEMES[1];

  document.documentElement.dataset.theme = id;
  document.documentElement.style.colorScheme = darkThemes.has(id) ? "dark" : "light";
  document.documentElement.style.setProperty("--theme-primary", theme.primary);
  document.documentElement.style.setProperty("--theme-primary-dark", darkThemes.has(id) ? theme.primary : theme.sidebar);
  document.documentElement.style.setProperty("--theme-primary-light", darkThemes.has(id) ? `${theme.primary}22` : `${theme.primary}14`);
  document.documentElement.style.setProperty("--theme-surface", theme.surface);
  document.documentElement.style.setProperty("--theme-soft", theme.background);
  document.documentElement.style.setProperty("--theme-text", theme.text);
  document.documentElement.style.setProperty("--theme-muted", theme.muted);
  document.documentElement.style.setProperty("--theme-border", theme.border);
  document.documentElement.style.setProperty("--theme-sidebar", theme.sidebar);
  document.documentElement.style.setProperty("--theme-input", theme.input);
  document.documentElement.style.setProperty("--theme-input-text", theme.text);
  document.documentElement.style.setProperty("--theme-neon-rgb", theme.neonRgb);
  document.documentElement.style.setProperty("--theme-glow", darkThemes.has(id) ? `0 0 22px rgba(${theme.neonRgb},.18)` : `0 0 16px rgba(${theme.neonRgb},.10)`);
  document.documentElement.style.setProperty("--theme-background", theme.background);
  localStorage.setItem(KEY, id);
  return id;
}
