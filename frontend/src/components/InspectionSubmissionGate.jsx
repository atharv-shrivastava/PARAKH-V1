import { useEffect, useMemo, useState } from "react";

const EMPTY_STATUS = {
  unableToVerify: 0,
  passed: 0,
  violations: 0,
  outOfScope: 0,
  officerResolvedCount: 0,
  totalUnresolved: 0,
  officerReviewRecorded: false,
  manualViolations: 0,
  selectedViolations: 0,
};

function readStatus() {
  return window.__parakhOfficerSummary || EMPTY_STATUS;
}

export default function InspectionSubmissionGate() {
  const [status, setStatus] = useState(() => readStatus());
  const [message, setMessage] = useState("");

  const active = useMemo(() => window.location.pathname.includes("/scan"), []);

  useEffect(() => {
    if (!active) return undefined;

    const handleSummary = (event) => {
      const next = event.detail || EMPTY_STATUS;
      setStatus(next);
      setMessage("");
      if (next.officerReviewRecorded) {
      }
    };

    const resetForNewScan = () => {
      setStatus(EMPTY_STATUS);
      setMessage("");
    };

    handleSummary({ detail: readStatus() });
    window.addEventListener("parakh:officer-summary", handleSummary);
    window.addEventListener("parakh:compliance-result", resetForNewScan);

    const submitGuard = (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.classList.contains("registration-form")) return;
      const next = readStatus();
      if (next.totalUnresolved > 0 || !next.officerReviewRecorded) {
        event.preventDefault();
        event.stopPropagation();
        setMessage(`Review all ${next.totalUnresolved} remaining Unable to Verify findings before submission.`);
      }
    };

    document.addEventListener("submit", submitGuard, true);
    return () => {
      document.removeEventListener("submit", submitGuard, true);
      window.removeEventListener("parakh:officer-summary", handleSummary);
      window.removeEventListener("parakh:compliance-result", resetForNewScan);
    };
  }, [active]);

  if (!active) return null;

  const ready = status.officerReviewRecorded && status.totalUnresolved === 0;

  return (
    <section className="scan-review inspection-submission-review officer-review-card" style={{ marginTop: 16 }}>
      <div className="section-heading">
        <div>
          <h2>Officer submission review</h2>
          <p>Submission is blocked until all Unable to Verify findings have been explicitly resolved by the officer.</p>
        </div>
        <strong>{ready ? "Ready for submission" : "Review required"}</strong>
      </div>

      <div className="ocr-status-grid">
        <div><strong>Unable to Verify</strong><span>{status.unableToVerify}</span></div>
        <div><strong>Passed</strong><span>{status.passed}</span></div>
        <div><strong>Violations</strong><span>{status.violations + status.manualViolations}</span></div>
        <div><strong>Out of Scope</strong><span>{status.outOfScope}</span></div>
        <div><strong>Officer decisions recorded</strong><span>{status.officerResolvedCount} / {status.totalUnresolved}</span></div>
        <div><strong>Officer review</strong><span>{status.officerReviewRecorded ? "Recorded" : "Not recorded"}</span></div>
      </div>

      {!ready && (
        <div className="status-message review-required-card" style={{ marginTop: 10 }}>
          Resolve the remaining Unable to Verify findings using the officer resolution controls above.
        </div>
      )}

      {message && (
        <div className="status-message review-required-card" style={{ marginTop: 10 }}>
          {message}
        </div>
      )}
    </section>
  );
}