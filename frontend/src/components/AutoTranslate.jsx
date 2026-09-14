import { useEffect, useRef } from "react";
import { apiFetch, getUser } from "../lib/auth";
import { useLanguage } from "./LanguageProvider";

const CACHE_VERSION = "v6";
const ATTRS = ["placeholder", "aria-label", "title"];
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT"]);
const PROTECTED = ".logo, .sidebar-user strong, [data-no-auto-translate=\"true\"], .language-picker";

const split = (value) => {
  const m = String(value).match(/^(\s*)([\s\S]*?)(\s*)$/);
  return { leading: m?.[1] || "", core: m?.[2] || String(value), trailing: m?.[3] || "" };
};

const technical = (value) => /^(?:[A-Z]{2,8}[-_\d]+|v?\d+(?:\.\d+){1,3}|\d{8,18})$/i.test(String(value || "").trim());

function skipNode(node) {
  const parent = node.parentElement;
  const text = node.nodeValue?.trim() || "";
  return !parent || SKIP_TAGS.has(parent.tagName) || !!parent.closest(PROTECTED) || text.length < 2 ||
    /^(?:https?:\/\/|www\.)/i.test(text) || /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(text) ||
    /^[\d\s.,:%+\-–—/()#]+$/.test(text) || technical(text);
}

function protect(value, user) {
  const terms = ["PARAKH", user?.name, user?.fullName, user?.displayName, user?.email]
    .map((v) => String(v || "").trim()).filter((v) => v.length >= 2).sort((a, b) => b.length - a.length)
    .filter((v, i, a) => a.indexOf(v) === i);
  const saved = [];
  let source = String(value);
  terms.forEach((term, i) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const token = `PARAKH_KEEP_${i}_TOKEN`;
    source = source.replace(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "gi"), (match) => {
      saved.push([token, match]);
      return token;
    });
  });
  return { source, restore: (text) => saved.reduce((out, [token, original]) => out.split(token).join(original), String(text || "")) };
}

export default function AutoTranslate() {
  const { language } = useLanguage();
  const originals = useRef(new WeakMap());
  const attributeOriginals = useRef(new WeakMap());
  const cache = useRef(new Map());
  const waiting = useRef(new Map());
  const queue = useRef([]);
  const flushing = useRef(false);
  const observer = useRef(null);
  const applying = useRef(new WeakSet());
  const timer = useRef(null);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const key = `parakh_translation_cache_${CACHE_VERSION}_${language}`;
    try { cache.current = new Map(Object.entries(JSON.parse(localStorage.getItem(key) || "{}"))); }
    catch { cache.current = new Map(); }
    let cancelled = false;

    const apply = (node, value) => {
      const { leading, trailing } = split(node.original);
      const translated = cache.current.get(split(node.original).core);
      if (!translated) return;
      applying.current.add(node.ref);
      node.apply(`${leading}${translated}${trailing}`);
      queueMicrotask(() => applying.current.delete(node.ref));
    };

    const enqueue = (original, ref, applyValue) => {
      const { core } = split(original);
      if (!core || technical(core)) return;
      const cached = cache.current.get(core);
      if (cached) { applyValue(cached); return; }
      let protectedText = protect(core, getUser());
      if (!waiting.current.has(core)) {
        waiting.current.set(core, []);
        queue.current.push({ core, source: protectedText.source, restore: protectedText.restore });
      }
      waiting.current.get(core).push({ ref, apply: applyValue });
    };

    const scan = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (skipNode(node)) continue;
        if (!originals.current.has(node)) originals.current.set(node, node.nodeValue || "");
        const original = originals.current.get(node);
        const { core } = split(original);
        if (core && language !== "en") enqueue(original, node, (value) => {
          applying.current.add(node);
          const { leading, trailing } = split(original);
          node.nodeValue = `${leading}${value}${trailing}`;
          queueMicrotask(() => applying.current.delete(node));
        });
      }
      if (root.querySelectorAll) {
        root.querySelectorAll("[placeholder], [aria-label], [title]").forEach((element) => {
          if (element.closest(PROTECTED)) return;
          if (!attributeOriginals.current.has(element)) attributeOriginals.current.set(element, {});
          const saved = attributeOriginals.current.get(element);
          ATTRS.forEach((attribute) => {
            const value = element.getAttribute(attribute);
            if (!value || value.trim().length < 2 || technical(value)) return;
            if (saved[attribute] == null) saved[attribute] = value;
            if (language !== "en") enqueue(saved[attribute], element, (translated) => element.setAttribute(attribute, translated));
          });
        });
      }
    };

    const flush = async () => {
      if (cancelled || flushing.current || language === "en" || !queue.current.length) return;
      flushing.current = true;
      const batch = queue.current.splice(0, 80);
      const active = batch.filter((item) => waiting.current.has(item.core));
      try {
        const response = await apiFetch("http://localhost:5000/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: language, source: "auto", texts: active.map((item) => item.source) }),
        });
        if (response.ok) {
          const data = await response.json().catch(() => ({}));
          active.forEach((item) => {
            const translated = data?.translations?.[item.source];
            if (typeof translated !== "string" || !translated.trim()) return;
            const value = item.restore(translated.trim());
            if (!value || value.toLowerCase() === item.core.toLowerCase()) return;
            cache.current.set(item.core, value);
            const targets = waiting.current.get(item.core) || [];
            targets.forEach((target) => target.apply(value));
            waiting.current.delete(item.core);
          });
        }
      } finally {
        active.forEach((item) => waiting.current.delete(item.core));
        flushing.current = false;
        localStorage.setItem(key, JSON.stringify(Object.fromEntries([...cache.current.entries()].slice(-2000))));
        if (queue.current.length) flush();
      }
    };

    const schedule = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(flush, 30); };
    if (language !== "en") { scan(document.body); schedule(); }

    observer.current = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList") mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) scan(node);
          else if (node.nodeType === Node.TEXT_NODE && !skipNode(node)) {
            if (!originals.current.has(node)) originals.current.set(node, node.nodeValue || "");
            enqueue(originals.current.get(node), node, (translated) => { node.nodeValue = translated; });
          }
        });
      }
      schedule();
    });
    observer.current.observe(document.body, { childList: true, subtree: true });

    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
      observer.current?.disconnect();
      if (language !== "en") {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const original = originals.current.get(node);
          if (original != null && node.nodeValue !== original) node.nodeValue = original;
        }
      }
    };
  }, [language]);

  return null;
}
