import { useEffect, useRef } from "react";
import { apiFetch, getUser } from "../lib/auth";
import { useLanguage } from "./LanguageProvider";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT"]);
const TRANSLATABLE_ATTRIBUTES = ["placeholder", "aria-label", "title"];
const CACHE_VERSION = "v5";
const IDENTITY_SELECTOR = ".logo, .sidebar-user strong, [data-no-auto-translate=\"true\"], .language-picker";

function shouldSkip(node) {
  const parent = node.parentElement;
  if (!parent || SKIP_TAGS.has(parent.tagName)) return true;
  if (parent.closest(IDENTITY_SELECTOR)) return true;
  const text = node.nodeValue?.trim() || "";
  if (text.length < 2) return true;
  if (/^(https?:\/\/|www\.)/i.test(text)) return true;
  if (/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(text)) return true;
  if (/^[\d\s.,:%+\-–—/()#]+$/.test(text)) return true;
  if (/^(PCR-|SIH|OKAY|VIOLATION|NEEDS_REVIEW|UNABLE_TO_VERIFY)[A-Z0-9_()./-]*$/i.test(text)) return true;
  return false;
}

function splitWhitespace(text) {
  const match = String(text).match(/^(\s*)([\s\S]*?)(\s*)$/);
  return { leading: match?.[1] || "", core: match?.[2] || String(text), trailing: match?.[3] || "" };
}

function isProbablyTechnicalText(text) {
  const value = String(text || "").trim();
  return /^(?:[A-Z]{2,8}[-_\d]+|v?\d+(?:\.\d+){1,3}|\d{8,18})$/.test(value);
}

function collectProtectedTerms(user) {
  return ["PARAKH", user?.name, user?.fullName, user?.displayName, user?.email]
    .map((value) => String(value || "").trim())
    .filter((value) => value.length >= 2)
    .sort((a, b) => b.length - a.length)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function protectTerms(text, protectedTerms) {
  let source = String(text);
  const protectedValues = [];
  protectedTerms.forEach((term, index) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "gi");
    source = source.replace(pattern, (match) => {
      const token = `PARAKHKEEP${index}TOKEN`;
      protectedValues.push({ token, value: match });
      return token;
    });
  });
  return {
    source,
    restore(translated) {
      let restored = String(translated || "");
      for (const item of protectedValues) restored = restored.split(item.token).join(item.value);
      return restored;
    },
  };
}

export default function AutoTranslate() {
  const { language } = useLanguage();
  const originals = useRef(new WeakMap());
  const attributeOriginals = useRef(new WeakMap());
  const cache = useRef(new Map());
  const busy = useRef(false);
  const observer = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const cacheKey = `parakh_translation_cache_${CACHE_VERSION}_${language}`;
    const protectedTerms = collectProtectedTerms(getUser());
    try {
      cache.current = new Map(Object.entries(JSON.parse(localStorage.getItem(cacheKey) || "{}")));
    } catch {
      cache.current = new Map();
    }
    let cancelled = false;

    const restore = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const original = originals.current.get(node);
        if (original != null && node.nodeValue !== original) node.nodeValue = original;
      }
      for (const element of document.body.querySelectorAll("[placeholder], [aria-label], [title]")) {
        const saved = attributeOriginals.current.get(element);
        if (!saved) continue;
        for (const attribute of TRANSLATABLE_ATTRIBUTES) {
          if (saved[attribute] != null) element.setAttribute(attribute, saved[attribute]);
        }
      }
    };

    async function process() {
      if (cancelled || busy.current) return;
      restore();
      const nodes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (shouldSkip(node)) continue;
        if (!originals.current.has(node)) originals.current.set(node, node.nodeValue || "");
        const original = originals.current.get(node) || "";
        const { core } = splitWhitespace(original);
        if (core && !isProbablyTechnicalText(core)) nodes.push(node);
      }

      const attributes = [];
      for (const element of document.body.querySelectorAll("[placeholder], [aria-label], [title]")) {
        if (element.closest(IDENTITY_SELECTOR)) continue;
        if (!attributeOriginals.current.has(element)) attributeOriginals.current.set(element, {});
        const saved = attributeOriginals.current.get(element);
        for (const attribute of TRANSLATABLE_ATTRIBUTES) {
          const value = element.getAttribute(attribute);
          if (!value || value.trim().length < 2 || isProbablyTechnicalText(value)) continue;
          if (saved[attribute] == null) saved[attribute] = value;
          attributes.push({ element, attribute, original: saved[attribute] });
        }
      }

      if (language === "en") return;
      const missing = [];
      const seen = new Set();
      const add = (value) => {
        const core = splitWhitespace(value).core;
        if (!core || seen.has(core) || cache.current.has(core) || isProbablyTechnicalText(core)) return;
        const protectedText = protectTerms(core, protectedTerms);
        seen.add(core);
        missing.push({ original: core, source: protectedText.source, restore: protectedText.restore });
      };
      nodes.forEach((item) => add(originals.current.get(item) || ""));
      attributes.forEach((item) => add(item.original));
      if (!missing.length) return;

      busy.current = true;
      try {
        for (let offset = 0; offset < missing.length; offset += 40) {
          const batchItems = missing.slice(offset, offset + 40);
          const response = await apiFetch("http://localhost:5000/api/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target: language, source: "auto", texts: batchItems.map((item) => item.source) }),
          });
          if (!response.ok) continue;
          const data = await response.json().catch(() => ({}));
          for (const item of batchItems) {
            const translated = data?.translations?.[item.source];
            if (typeof translated !== "string" || !translated.trim()) continue;
            const restored = item.restore(translated.trim());
            if (restored && restored.toLowerCase() !== item.original.toLowerCase()) cache.current.set(item.original, restored);
          }
        }
        localStorage.setItem(cacheKey, JSON.stringify(Object.fromEntries([...cache.current.entries()].slice(-1600))));
        for (const item of nodes) {
          const original = originals.current.get(item);
          if (!original) continue;
          const { leading, core, trailing } = splitWhitespace(original);
          const translated = cache.current.get(core);
          if (translated) item.nodeValue = `${leading}${translated}${trailing}`;
        }
        for (const item of attributes) {
          const { leading, core, trailing } = splitWhitespace(item.original);
          const translated = cache.current.get(core);
          if (translated) item.element.setAttribute(item.attribute, `${leading}${translated}${trailing}`);
        }
      } finally {
        busy.current = false;
      }
    }

    const schedule = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(process, 180);
    };
    schedule();
    observer.current = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.type === "childList" && mutation.addedNodes.length)) schedule();
    });
    observer.current.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
      observer.current?.disconnect();
      restore();
    };
  }, [language]);

  return null;
}
