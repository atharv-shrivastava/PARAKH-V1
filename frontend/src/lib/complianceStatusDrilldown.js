const STYLE_ID = "parakh-compliance-status-drilldown-style";
const PANEL_ID = "parakh-compliance-status-drilldown-panel";
const CARD_ID = "parakh-compliance-status-drilldown-cards";
const STATUS_META = [
  { key: "UNABLE_TO_VERIFY", label: "Unable to verify" },
  { key: "PASS", label: "Passed" },
  { key: "VIOLATION", label: "Violation" },
  { key: "NOT_APPLICABLE", label: "Out of scope" },
];

let latestCompliance = null;
let activeStatus = null;
let scheduled = false;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${CARD_ID}{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:12px 0 0}
    .parakh-status-filter{border:1px solid var(--theme-border,var(--border-color,#d8dee8));background:var(--theme-surface,var(--card-background,#fff));color:var(--theme-text,var(--text-primary,#172033));border-radius:12px;padding:12px;text-align:left;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease,border-color .15s ease;box-shadow:var(--theme-shadow,0 2px 8px rgba(15,23,42,.06))}
    .parakh-status-filter:hover{transform:translateY(-1px);box-shadow:0 5px 18px rgba(0,0,0,.14)}
    .parakh-status-filter[data-active="true"]{border-color:var(--theme-primary,currentColor);box-shadow:0 0 0 2px color-mix(in srgb,var(--theme-primary) 18%,transparent)}
    .parakh-status-filter strong{display:block;font-size:14px;margin-bottom:4px;color:var(--theme-text,var(--text-primary,#172033))}
    .parakh-status-filter span{display:block;font-size:24px;font-weight:800;line-height:1.1;color:var(--theme-text,var(--text-primary,#172033))}
    .parakh-status-filter[data-status="UNABLE_TO_VERIFY"]{border-left:4px solid #d97706}
    .parakh-status-filter[data-status="PASS"]{border-left:4px solid #16a34a}
    .parakh-status-filter[data-status="VIOLATION"]{border-left:4px solid #dc2626}
    .parakh-status-filter[data-status="NOT_APPLICABLE"]{border-left:4px solid #64748b}
    #${PANEL_ID}{margin-top:12px;border:1px solid var(--theme-border,var(--border-color,#d8dee8));border-radius:14px;padding:14px;background:var(--theme-surface,var(--card-background,#fff));color:var(--theme-text,var(--text-primary,#172033));box-shadow:var(--theme-shadow,0 4px 16px rgba(15,23,42,.06))}
    .parakh-drilldown-header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:10px;color:var(--theme-text,var(--text-primary,#172033))}
    .parakh-drilldown-header h3{margin:0;font-size:16px;color:var(--theme-text,var(--text-primary,#172033))}
    .parakh-drilldown-header small{color:var(--theme-muted,var(--text-secondary,#647084))}
    .parakh-drilldown-header button{border:0;background:transparent;color:var(--theme-text,var(--text-primary,#172033));cursor:pointer;font-size:18px;line-height:1}
    .parakh-drilldown-item{border:1px solid var(--theme-border,var(--border-color,#d8dee8));border-radius:10px;padding:11px 12px;margin-top:8px;background:var(--theme-soft,var(--muted-bg,#f8fafc));color:var(--theme-text,var(--text-primary,#172033))}
    .parakh-drilldown-item strong{display:block;color:var(--theme-text,var(--text-primary,#172033))}
    .parakh-drilldown-item small{display:block;margin-top:3px;color:var(--theme-muted,var(--text-secondary,#647084));opacity:1}
    .parakh-drilldown-item p{margin:7px 0 0;line-height:1.45;color:var(--theme-text,var(--text-primary,#172033))}
    @media (max-width:760px){#${CARD_ID}{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media (max-width:420px){#${CARD_ID}{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

function findingDetails(finding) {
  const code = finding.ruleCode || `R${finding.ruleNumber || "-"}`;
  const title = finding.ruleTitle || "Rules Engine finding";
  const issue = finding.violationReason || finding.message || finding.ruleStatement || "No additional finding details.";
  return { code, title, issue };
}

function renderDrilldown(status) {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  if (!status) {
    panel.remove();
    return;
  }
  const findings = Array.isArray(latestCompliance?.findings)
    ? latestCompliance.findings.filter((finding) => finding.status === status)
    : [];
  const label = STATUS_META.find((item) => item.key === status)?.label || status;
  panel.innerHTML = `
    <div class="parakh-drilldown-header">
      <div><h3>${label}</h3><small>${findings.length} rule${findings.length === 1 ? "" : "s"} in this category</small></div>
      <button type="button" aria-label="Close finding list">×</button>
    </div>
    <div class="parakh-drilldown-list">
      ${findings.length ? findings.map((finding) => {
        const details = findingDetails(finding);
        return `<div class="parakh-drilldown-item">
          <strong>${details.code} · ${details.title}</strong>
          <small>Rule ${finding.ruleNumber || "Unspecified"}</small>
          <p>${details.issue}</p>
        </div>`;
      }).join("") : `<div class="parakh-drilldown-item"><strong>No findings</strong><p>There are no rules currently in this category.</p></div>`}
    </div>
  `;
  panel.querySelector("button")?.addEventListener("click", () => {
    activeStatus = null;
    renderDrilldown(null);
    updateCards();
  }, { once: true });
}

function counts() {
  const findings = Array.isArray(latestCompliance?.findings) ? latestCompliance.findings : [];
  return Object.fromEntries(STATUS_META.map(({ key }) => [key, findings.filter((finding) => finding.status === key).length]));
}

function updateCards() {
  const container = document.getElementById(CARD_ID);
  if (!container) return;
  const summary = counts();
  const signature = `${activeStatus || ""}|${STATUS_META.map(({ key }) => summary[key]).join(",")}`;
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  container.innerHTML = STATUS_META.map(({ key, label }) => `
    <button type="button" class="parakh-status-filter" data-status="${key}" data-active="${String(activeStatus === key)}">
      <strong>${label}</strong><span>${summary[key] || 0}</span>
    </button>
  `).join("");
  container.querySelectorAll("button[data-status]").forEach((button) => {
    button.addEventListener("click", () => {
      const status = button.dataset.status;
      activeStatus = activeStatus === status ? null : status;
      updateCards();
      renderDrilldown(activeStatus);
    });
  });
}

function enhanceSummary() {
  const summary = Array.from(document.querySelectorAll(".ocr-summary"))
    .find((node) => /^Rules:\s*\d+/i.test(node.textContent.trim()));
  if (!summary || !latestCompliance) return;

  injectStyles();
  let cards = document.getElementById(CARD_ID);
  if (!cards) {
    cards = document.createElement("div");
    cards.id = CARD_ID;
    summary.insertAdjacentElement("afterend", cards);
    cards.dataset.signature = "";
  }
  updateCards();

  let panel = document.getElementById(PANEL_ID);
  if (!activeStatus) {
    panel?.remove();
    return;
  }
  if (!panel) {
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    cards.insertAdjacentElement("afterend", panel);
  }
  renderDrilldown(activeStatus);
}

function scheduleEnhance() {
  if (scheduled) return;
  scheduled = true;
  window.requestAnimationFrame(() => {
    scheduled = false;
    enhanceSummary();
  });
}

export function installComplianceStatusDrilldown() {
  if (window.__parakhComplianceStatusDrilldownInstalled) return;
  window.__parakhComplianceStatusDrilldownInstalled = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const input = args[0];
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/ocr/evaluate-structured")) {
      response.clone().json().then((payload) => {
        latestCompliance = payload?.compliance || null;
        activeStatus = null;
        window.dispatchEvent(new CustomEvent("parakh:compliance-result", { detail: latestCompliance }));
        scheduleEnhance();
      }).catch(() => {});
    }
    return response;
  };

  const observer = new MutationObserver(() => scheduleEnhance());
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("parakh:compliance-result", scheduleEnhance);
}
