import { useEffect, useMemo, useState } from "react";
import "../styles/unable-to-verify-review.css";

const REVIEW_EVENT = "parakh:unable-to-verify-review";
const DECISIONS_KEY = "parakhUnableToVerifyDecisions";
const CAPTURED_KEY = "parakhCapturedCompliance";

function findingStatus(finding) {
  return String(finding?.status || "").toUpperCase();
}

function unableFindings(compliance) {
  return Array.isArray(compliance?.findings)
    ? compliance.findings.filter((finding) => findingStatus(finding) === "UNABLE_TO_VERIFY")
    : [];
}

function clearReviewStorage() {
  try {
    window.sessionStorage.removeItem(CAPTURED_KEY);
    window.sessionStorage.removeItem(DECISIONS_KEY);
  } catch {}
}

function syncRegistrationDom(unresolvedCount, failCount) {
  const button = Array.from(document.querySelectorAll("button[type=submit]"))
    .find((candidate) => /Register Offline Product/i.test(candidate.textContent || ""));
  if (button) {
    if (unresolvedCount > 0) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      button.dataset.parakhReviewBlocked = "true";
    } else if (button.dataset.parakhReviewBlocked === "true") {
      button.disabled = false;
      button.removeAttribute("aria-disabled");
      delete button.dataset.parakhReviewBlocked;
    }
  }

  const finalStatusLabel = Array.from(document.querySelectorAll("strong"))
    .find((candidate) => String(candidate.textContent || "").trim() === "Final status");
  if (!finalStatusLabel) return;
  const statusSpan = finalStatusLabel.parentElement?.querySelector("span");
  if (!statusSpan) return;
  if (unresolvedCount > 0) {
    statusSpan.textContent = "NEEDS_REVIEW";
    return;
  }

  const grid = finalStatusLabel.closest(".ocr-status-grid");
  const selectedLabel = Array.from(grid?.querySelectorAll("strong") || [])
    .find((candidate) => String(candidate.textContent || "").trim() === "Selected violations");
  const selectedCount = Number.parseInt(
    selectedLabel?.parentElement?.querySelector("span")?.textContent || "0",
    10,
  ) || 0;
  statusSpan.textContent = failCount > 0 || selectedCount > 0 ? "VIOLATION" : "OKAY";
}

export default function ScanUnableToVerifyReview() {
  const [compliance, setCompliance] = useState(null);
  const [decisions, setDecisions] = useState({});

  useEffect(() => {
    clearReviewStorage();

    const nativeFetch = window.fetch.bind(window);

    const handleEvaluateResponse = async (response) => {
      try {
        const payload = await response.clone().json();
        const nextCompliance = payload?.compliance || null;
        clearReviewStorage();
        if (!nextCompliance) {
          setCompliance(null);
          setDecisions({});
          return;
        }
        setCompliance(nextCompliance);
        setDecisions({});
        window.sessionStorage.setItem(CAPTURED_KEY, JSON.stringify(nextCompliance));
        window.sessionStorage.removeItem(DECISIONS_KEY);
      } catch {
        setCompliance(null);
        setDecisions({});
      }
    };

    window.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input?.url || "";
      const method = String(init?.method || input?.method || "GET").toUpperCase();

      if (method === "POST" && /\/api\/ocr\/evaluate-structured(?:\?|$)/.test(url)) {
        const response = await nativeFetch(input, init);
        await handleEvaluateResponse(response);
        return response;
      }

      if (method === "POST" && /\/api\/products(?:\?|$)/.test(url)) {
        const rawBody = init?.body;
        if (typeof rawBody !== "string") return nativeFetch(input, init);

        let body;
        try {
          body = JSON.parse(rawBody);
        } catch {
          return nativeFetch(input, init);
        }

        const bodyCompliance = body?.ocrData?.compliance;
        const findings = Array.isArray(bodyCompliance?.findings) ? bodyCompliance.findings : [];
        const unable = findings.filter((finding) => findingStatus(finding) === "UNABLE_TO_VERIFY");
        if (!unable.length) return nativeFetch(input, init);

        const unresolved = unable.filter((finding) => !decisions[finding.findingId]);
        if (unresolved.length) {
          return new Response(JSON.stringify({
            error: `Resolve ${unresolved.length} unable-to-verify rule${unresolved.length === 1 ? "" : "s"} as Pass or Fail before registering the product.`,
            status: "UNABLE_TO_VERIFY_REVIEW_REQUIRED",
            unresolvedFindingIds: unresolved.map((finding) => finding.findingId),
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const failIds = unable
          .filter((finding) => decisions[finding.findingId] === "FAIL")
          .map((finding) => finding.findingId);
        const passIds = unable
          .filter((finding) => decisions[finding.findingId] === "PASS")
          .map((finding) => finding.findingId);
        const failSet = new Set(failIds);
        const passSet = new Set(passIds);
        const originalSummary = bodyCompliance?.summary || {};

        const transformedFindings = findings.map((finding) => {
          if (!failSet.has(finding.findingId) && !passSet.has(finding.findingId)) return finding;
          const decision = decisions[finding.findingId];
          return {
            ...finding,
            status: decision === "FAIL" ? "VIOLATION" : "PASS",
            severity: decision === "FAIL" ? (finding.severity || "REVIEW") : finding.severity,
            message: decision === "FAIL"
              ? `${finding.message || finding.violationReason || "Unable to verify this rule."} Inspector marked Fail.`
              : `${finding.message || finding.violationReason || "Unable to verify this rule."} Inspector marked Pass.`,
            violationReason: decision === "FAIL"
              ? `${finding.violationReason || finding.message || "Unable to verify this rule."} Inspector marked Fail.`
              : finding.violationReason,
          };
        });

        const transformedCompliance = {
          ...bodyCompliance,
          findings: transformedFindings,
          summary: {
            ...originalSummary,
            unableToVerify: 0,
            violations: Number(originalSummary.violations || 0) + failIds.length,
            passed: Number(originalSummary.passed || 0) + passIds.length,
          },
        };

        body.ocrData = {
          ...(body.ocrData || {}),
          compliance: transformedCompliance,
          unableVerificationDecisions: { ...decisions },
        };
        body.acceptedFindingIds = [...new Set([
          ...(Array.isArray(body.acceptedFindingIds) ? body.acceptedFindingIds : []),
          ...failIds,
        ])];

        return nativeFetch(input, {
          ...init,
          body: JSON.stringify(body),
        });
      }

      return nativeFetch(input, init);
    };

    const handleResetClick = (event) => {
      const button = event.target?.closest?.("button");
      if (!button || !/Stop\s*&\s*Reset Scan/i.test(button.textContent || "")) return;
      clearReviewStorage();
      setCompliance(null);
      setDecisions({});
    };

    document.addEventListener("click", handleResetClick, true);
    window.addEventListener(REVIEW_EVENT, () => {});

    return () => {
      window.fetch = nativeFetch;
      document.removeEventListener("click", handleResetClick, true);
    };
  }, [decisions]);

  const unable = useMemo(() => unableFindings(compliance), [compliance]);
  const unresolvedCount = unable.filter((finding) => !decisions[finding.findingId]).length;
  const failCount = unable.filter((finding) => decisions[finding.findingId] === "FAIL").length;
  const passCount = unable.filter((finding) => decisions[finding.findingId] === "PASS").length;

  useEffect(() => {
    syncRegistrationDom(unresolvedCount, failCount);
  }, [unresolvedCount, failCount]);

  if (!compliance || !unable.length) return null;

  const choose = (findingId, decision) => {
    setDecisions((current) => ({ ...current, [findingId]: decision }));
  };

  return (
    <section className="scan-review rule-review-panel" style={{ marginTop: 20, borderLeft: "4px solid currentColor" }}>
      <div className="section-heading">
        <div>
          <h2>Unable-to-verify rules</h2>
          <p>Each unresolved rule requires an inspector decision. Pass records the rule as passed. Fail records it as a violation. You do not need to select every detected violation elsewhere.</p>
        </div>
      </div>

      <div className="ocr-summary">
        Pending: <strong>{unresolvedCount}</strong> · Pass: <strong>{passCount}</strong> · Fail: <strong>{failCount}</strong>
      </div>

      {unresolvedCount > 0 && <div className="status-message">Resolve every unable-to-verify rule before registration.</div>}

      {unable.map((finding) => {
        const decision = decisions[finding.findingId] || "";
        const ruleNumber = finding.ruleNumber || finding.ruleCode || "Unspecified";
        const title = finding.ruleTitle || finding.message || "Rules Engine finding";
        const statement = finding.ruleStatement || finding.violationReason || finding.message || "The Rules Engine could not verify this rule.";

        return (
          <details className="rule-review-dropdown" key={finding.findingId} open>
            <summary>
              <span>
                <strong>Rule {ruleNumber}</strong>
                <small>{title} · Unable to verify</small>
              </span>
            </summary>
            <div className="rule-review-dropdown-body">
              <p><strong>Rule statement</strong>{statement}</p>
              <p><strong>Engine finding</strong>{finding.message || finding.violationReason || "The rule could not be verified from the available evidence."}</p>
              <div className="scan-upload-actions" style={{ marginTop: 12 }}>
                <button type="button" className={decision === "PASS" ? "primary-button" : "secondary-button"} onClick={() => choose(finding.findingId, "PASS")}>Pass</button>
                <button type="button" className={decision === "FAIL" ? "primary-button" : "secondary-button"} onClick={() => choose(finding.findingId, "FAIL")}>Fail</button>
                {decision && <span className="status-message">Inspector decision: <strong>{decision}</strong></span>}
              </div>
            </div>
          </details>
        );
      })}
    </section>
  );
}
