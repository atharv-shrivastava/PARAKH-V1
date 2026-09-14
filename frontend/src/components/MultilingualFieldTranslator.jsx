import { useEffect, useRef } from "react";
import { apiFetch, getUser } from "../lib/auth";
import { getLanguage } from "../lib/language";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";
const SKIP = new Set(["password", "email", "tel", "number", "date"]);
const TECHNICAL = /^(?:\d[\d\s.,:/+%()-]*|[A-Z0-9][A-Z0-9._/@:#-]{6,})$/i;

function shouldTranslateValue(element, value) {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
  if (!value || value.trim().length < 2) return false;
  if (SKIP.has(String(element.type || "").toLowerCase())) return false;
  if (element.disabled || element.readOnly) return false;
  if (element.closest(".language-picker,[data-no-auto-translate=\"true\"]")) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return false;
  if (/^(https?:\/\/|www\.)/i.test(value.trim())) return false;
  if (TECHNICAL.test(value.trim())) return false;
  return /[^\x00-\x7F]/u.test(value) || Boolean(element.closest(".ocr-edit-field,.registration-form"));
}

function isSignupIdentity(element) {
  const text = `${element.name || ""} ${element.id || ""} ${element.getAttribute("aria-label") || ""}`.toLowerCase();
  return /(^|\W)(name|email|username)(\W|$)/.test(text) && element.closest("form") && !element.closest(".registration-form");
}

function setControlledValue(element, value) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value); else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

export default function MultilingualFieldTranslator() {
  const originals = useRef(new WeakMap());
  const translating = useRef(false);
  const timer = useRef(null);

  useEffect(() => {
    const translateVisibleFields = async () => {
      if (translating.current) return;
      const language = getLanguage(getUser()?.id);
      if (language === "en") return;

      const elements = [...document.querySelectorAll("input, textarea")]
        .filter((element) => !isSignupIdentity(element) && shouldTranslateValue(element, element.value));
      if (!elements.length) return;

      const candidates = [];
      for (const element of elements) {
        const current = element.value.trim();
        const original = originals.current.get(element) || current;
        if (!originals.current.has(element)) originals.current.set(element, current);
        if (!shouldTranslateValue(element, current)) continue;
        if (current !== original && element.dataset.parakhTranslated !== "true") continue;
        candidates.push({ element, original });
      }
      if (!candidates.length) return;

      const unique = [...new Set(candidates.map((item) => item.original))];
      translating.current = true;
      try {
        const response = await apiFetch(`${API_URL}/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: language, source: "auto", texts: unique }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return;
        for (const { element, original } of candidates) {
          const translated = data?.translations?.[original];
          if (typeof translated !== "string" || !translated.trim() || translated.trim() === original.trim()) continue;
          if (document.activeElement === element && element.dataset.parakhTranslated !== "true") continue;
          const next = translated.trim();
          setControlledValue(element, next);
          element.dataset.parakhTranslated = "true";
        }
      } finally {
        translating.current = false;
      }
    };

    const schedule = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(translateVisibleFields, 250);
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    const interval = window.setInterval(schedule, 1200);

    return () => {
      window.clearTimeout(timer.current);
      window.clearInterval(interval);
      observer.disconnect();
    };
  }, []);

  return null;
}
