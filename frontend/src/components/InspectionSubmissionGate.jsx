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

export default function InspectionSubmissionGate({ status: incomingStatus }) {
  const [message, setMessage] = useState("");
  const active = useMemo(() => window.location.pathname.includes("/scan"), []);
  const status = incomingStatus || EMPTY_STATUS;

  useEffect(() => {
    if (!active) return undefined;

    const submitGuard = (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.classList.contains("registration-form")) return;
      if (Number(status.unableToVerify || 0) > 0) {
        event.preventDefault();
        event.stopPropagation();
        setMessage(
          `Review all ${Number(status.unableToVerify || 0)} remaining Unable to Verify findings before submission.`,
        );
      }
    };

    document.addEventListener("submit", submitGuard, true);
    return () => document.removeEventListener("submit", submitGuard, true);
  }, [active, status]);

  useEffect(() => {
    setMessage("");
  }, [
    status.unableToVerify,
    status.passed,
    status.violations,
    status.outOfScope,
    status.officerResolvedCount,
    status.totalUnresolved,
  ]);

  if (!active) return null;

  // The current Unable to Verify count is the single source of truth.
  // totalUnresolved is the initial review workload and must not gate readiness.
  const reviewRecorded = Number(status.unableToVerify || 0) === 0;
  const ready = reviewRecorded;

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
        <div><strong>Officer review</strong><span>{reviewRecorded ? "Recorded" : "Not recorded"}</span></div>
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
