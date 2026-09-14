import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import ScanUnableToVerifyReview from "./ScanUnableToVerifyReview";
import "../styles/unable-to-verify-review.css";

export default function ScanScopedUnableToVerifyReview() {
  const [host, setHost] = useState(null);

  useEffect(() => {
    const syncHost = () => setHost(document.querySelector(".scan-page"));
    syncHost();
    const observer = new MutationObserver(syncHost);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", syncHost);
    return () => {
      observer.disconnect();
      window.removeEventListener("popstate", syncHost);
    };
  }, []);

  if (!host || !/\/scan(?:\/|$)/i.test(window.location.pathname)) return null;

  return createPortal(
    <div className="parakh-unable-review-host">
      <ScanUnableToVerifyReview />
    </div>,
    host,
  );
}
