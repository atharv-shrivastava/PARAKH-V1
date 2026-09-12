import { useEffect, useMemo, useState } from "react";

const REVIEW_KEY = "parakhOfficerReviewAcknowledged";

function readStatus() {
  const text = document.body?.innerText || "";
  const unableMatch = text.match(/Unable to verify\s*(\d+)/i);
  const violationMatch = text.match(/Selected engine violations:\s*(\d+)\s*of\s*(\d+)/i);
  return {
    unableToVerify: unableMatch ? Number(unableMatch[1]) : 0,
    selectedViolations: violationMatch ? Number(violationMatch[1]) : 0,
    totalViolations: violationMatch ? Number(violationMatch[2]) : 0,
  };
}

export default function InspectionSubmissionGate() {
  const [status, setStatus] = useState(() => readStatus());
  const [reviewed, setReviewed] = useState(() => sessionStorage.getItem(REVIEW_KEY) === "true");
  const [message, setMessage] = useState("");

  const active = useMemo(() => window.location.pathname.includes("/scan"), []);

  useEffect(() => {
    if (!active) return undefined;
    const refresh = () => {
      const next = readStatus();
      setStatus(next);
      setMessage("");
      if (next.unableToVerify === 0 && next.totalViolations === 0) {
        sessionStorage.removeItem(REVIEW_KEY);
        setReviewed(false);
      }
    };
    const resetForNewScan = () => {
      sessionStorage.removeItem(REVIEW_KEY);
      setReviewed(false);
      setStatus(readStatus());
      setMessage("");
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true });
    const submitGuard = (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.classList.contains("registration-form")) return;
      const next = readStatus();
      const engineViolationsResolved = next.totalViolations === 0 || next.selectedViolations === next.totalViolations;
      if (!engineViolationsResolved) {
        event.preventDefault();
        event.stopPropagation();
        setMessage(`Review all ${next.totalViolations - next.selectedViolations} engine violation${next.totalViolations - next.selectedViolations === 1 ? "" : "s"} before submission.`);
        return;
      }
      if (next.unableToVerify > 0 && !reviewed) {
        event.preventDefault();
        event.stopPropagation();
        setMessage(`Review all ${next.unableToVerify} Unable to Verify findings. Keep them as review findings or record an explicit inspector violation before submission.`);
      }
    };
    document.addEventListener("submit", submitGuard, true);
    window.addEventListener("parakh:compliance-result", resetForNewScan);
    return () => {
      observer.disconnect();
      document.removeEventListener("submit", submitGuard, true);
      window.removeEventListener("parakh:compliance-result", resetForNewScan);
    };
  }, [active, reviewed]);

  if (!active) return null;

  const ready = reviewed && (status.totalViolations === 0 || status.selectedViolations === status.totalViolations) && status.unableToVerify === 0;

  return (
    <section className="scan-review inspection-submission-review officer-review-card" style={{ marginTop: 16 }}>
      <div className="section-heading">
        <div>
          <h2>Officer submission review</h2>
          <p>Submission is blocked until engine violations are explicitly resolved and all Unable to Verify findings have been reviewed.</p>
        </div>
        <strong>{ready ? "Ready for submission" : "Review required"}</strong>
      </div>

      <div className="ocr-status-grid">
        <div><strong>Unable to Verify</strong><span>{status.unableToVerify}</span></div>
        <div><strong>Engine violations selected</strong><span>{status.selectedViolations} / {status.totalViolations}</span></div>
        <div><strong>Officer review</strong><span>{reviewed ? "Recorded" : "Not recorded"}</span></div>
      </div>

      {status.unableToVerify > 0 && <button type="button" className="secondary-button" onClick={() => { sessionStorage.setItem(REVIEW_KEY, "true"); setReviewed(true); setMessage("Officer review recorded. The unresolved findings remain explicitly classified as Unable to Verify unless an inspector adds a violation."); }}>
        Mark current unresolved findings as reviewed / Unable to Verify
      </button>}

      {status.totalViolations > 0 && status.selectedViolations < status.totalViolations && <div className="status-message review-required-card" style={{ marginTop: 10 }}>
        {status.totalViolations - status.selectedViolations} engine violation{status.totalViolations - status.selectedViolations === 1 ? "" : "s"} still require explicit officer selection.
      </div>}

      {message && <div className="status-message review-required-card" style={{ marginTop: 10 }}>{message}</div>}
    </section>
  );
}
