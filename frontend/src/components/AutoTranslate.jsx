import { useEffect, useRef } from "react";
import { apiFetch, getUser } from "../lib/auth";
import { useLanguage } from "./LanguageProvider";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"]);
const SKIP_SELECTOR = "[data-no-auto-translate=\"true\"], .language-picker";
const IDENTITY_SELECTOR = "[data-no-auto-translate=\"true\"], .product-identity, .category-identity, .shop-identity, .product-name, .shop-name, .username, .user-name, .inspector-name";
const TRANSLATABLE_ATTRIBUTES = ["placeholder", "aria-label", "title"];
const CACHE_VERSION = "v5";

function shouldSkip(node) {
  const parent = node.parentElement;
  if (!parent || SKIP_TAGS.has(parent.tagName)) return true;
  if (parent.closest(IDENTITY_SELECTOR) || parent.closest(SKIP_SELECTOR)) return true;
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

function isDynamicIdentityElement(element) {
  if (!(element instanceof Element)) return false;
  return Boolean(element.closest(IDENTITY_SELECTOR));
}

function isProbablyTechnicalText(text) {
  return /^(?:[A-Z]{2,8}[-_\d]+|v?\d+(?:\.\d+){1,3}|\d{8,18})$/.test(text.trim());
}

function collectProtectedTerms(user) {
  const values = [
    "PARAKH",
    user?.name,
    user?.fullName,
    user?.displayName,
    user?.email,
  ]
    .map((value) => String(value || "").trim())
    .filter((value) => value.length >= 2);

  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

function protectTerms(text, protectedTerms) {
  if (!protectedTerms.length) return { source: text, restore: (translated) => translated };

  let source = String(text);
  const protectedValues = [];
  let tokenIndex = 0;

  for (const term of protectedTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "gi");
    source = source.replace(pattern, (match) => {
      const token = `PARAKHKEEP${tokenIndex}TOKEN`;
      protectedValues.push({ token, value: match });
      tokenIndex += 1;
      return token;
    });
  }

  return {
    source,
    restore(translated) {
      let restored = String(translated || "");
      for (const { token, value } of protectedValues) {
        restored = restored.split(token).join(value);
      }
      return restored;
    },
  };
}

function normalizeTranslationForDisplay(translated, original) {
  const value = String(translated || "").trim();
  const source = String(original || "").trim();
  if (!value || !source) return "";
  if (value.toLowerCase() === source.toLowerCase()) return "";
  return value;
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
      const stored = JSON.parse(localStorage.getItem(cacheKey) || "{}");
      cache.current = new Map(Object.entries(stored));
    } catch {
      cache.current = new Map();
    }

    let cancelled = false;

    function restoreTrackedEnglish() {
      if (typeof document === "undefined") return;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const original = originals.current.get(node);
        if (original != null && node.nodeValue !== original) node.nodeValue = original;
      }

      for (const element of document.body.querySelectorAll("[placeholder], [aria-label], [title]")) {
        const originalsForElement = attributeOriginals.current.get(element);
        if (!originalsForElement) continue;
        for (const attribute of TRANSLATABLE_ATTRIBUTES) {
          if (originalsForElement[attribute] != null && element.getAttribute(attribute) !== originalsForElement[attribute]) {
            element.setAttribute(attribute, originalsForElement[attribute]);
          }
        }
      }
    }

    async function process() {
      if (cancelled || busy.current) return;
      const root = document.body;
      if (!root) return;

      restoreTrackedEnglish();

      const nodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (shouldSkip(node)) continue;
        if (!originals.current.has(node)) originals.current.set(node, node.nodeValue || "");
        const original = originals.current.get(node) || "";
        const { core } = splitWhitespace(original);
        if (!core || isProbablyTechnicalText(core)) continue;
        nodes.push(node);
      }

      const elements = [];
      for (const element of root.querySelectorAll("[placeholder], [aria-label], [title]")) {
        if (isDynamicIdentityElement(element) || element.closest(SKIP_SELECTOR)) continue;
        for (const attribute of TRANSLATABLE_ATTRIBUTES) {
          if (!element.hasAttribute(attribute)) continue;
          const value = element.getAttribute(attribute) || "";
          if (value.trim().length < 2 || isProbablyTechnicalText(value)) continue;
          if (!attributeOriginals.current.has(element)) attributeOriginals.current.set(element, {});
          const originalsForElement = attributeOriginals.current.get(element);
          if (originalsForElement[attribute] == null) originalsForElement[attribute] = value;
          elements.push({ element, attribute, original: originalsForElement[attribute] });
        }
      }

      if (language === "en") return;

      const missing = [];
      const missingSet = new Set();
      const addMissing = (value) => {
        const core = splitWhitespace(value).core;
        if (!core || isProbablyTechnicalText(core) || missingSet.has(core) || cache.current.has(core)) return;

        const protectedText = protectTerms(core, protectedTerms);
        missingSet.add(core);
        missing.push({ original: core, source: protectedText.source, restore: protectedText.restore });
      };

      for (const item of nodes) addMissing(originals.current.get(item) || "");
      for (const item of elements) addMissing(item.original);

      busy.current = true;
      try {
        for (let offset = 0; offset < missing.length; offset += 40) {
          const batchItems = missing.slice(offset, offset + 40);
          const batch = batchItems.map((item) => item.source);
          const response = await apiFetch("http://localhost:5000/api/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target: language, texts: batch }),
          });
          if (!response.ok) throw new Error(`Translation request failed (${response.status}).`);
          const data = await response.json().catch(() => null);
          const failedTexts = new Set(Array.isArray(data?.failures) ? data.failures.map((item) => String(item?.text || "")) : []);

          for (const item of batchItems) {
            if (failedTexts.has(item.source)) continue;
            const translated = data?.translations?.[item.source];
            if (typeof translated !== "string") continue;
            const restored = item.restore(translated);
            const displayValue = normalizeTranslationForDisplay(restored, item.original);
            if (displayValue) cache.current.set(item.original, displayValue);
          }
          if (cancelled) return;
        }

        const compact = Object.fromEntries([...cache.current.entries()].slice(-1200));
        localStorage.setItem(cacheKey, JSON.stringify(compact));

        for (const item of nodes) {
          const original = originals.current.get(item);
          if (!original) continue;
          const { leading, core, trailing } = splitWhitespace(original);
          const translated = cache.current.get(core);
          if (translated) item.nodeValue = `${leading}${translated}${trailing}`;
        }
        for (const item of elements) {
          const { leading, core, trailing } = splitWhitespace(item.original);
          const translated = cache.current.get(core);
          if (translated) item.element.setAttribute(item.attribute, `${leading}${translated}${trailing}`);
        }
      } catch {
        // Keep English source text when translation is unavailable or malformed.
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
      restoreTrackedEnglish();
    };
  }, [language]);

  return null;
}
