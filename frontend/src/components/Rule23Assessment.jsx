import { useEffect, useState } from "react";

const STORAGE_KEY = "parakhRule23Assessment";

const DEFAULTS = {
  visualInspectionPerformed: false,
  deceptivePackage: null,
  quantityAgreesWithDeclaration: null,
  largerDimensionsJustified: null,
  repackedAndRelabeled: null,
};

function readStored() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
    return { ...DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(next) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent("parakh:rule23-assessment", { detail: next }));
}

export default function Rule23Assessment() {
  const [assessment, setAssessment] = useState(readStored);

  useEffect(() => {
    persist(assessment);
  }, [assessment]);

  if (!window.location.pathname.includes("/scan")) return null;

  const update = (key, value) => setAssessment((current) => ({ ...current, [key]: value }));
  const complete = assessment.visualInspectionPerformed && assessment.deceptivePackage !== null;
  const potentiallyDeceptive = assessment.deceptivePackage === true;

  return (
    <section className="scan-review rule23-assessment" style={{ marginTop: 16 }}>
      <div className="section-heading">
        <div>
          <h2>Rule 23 visual assessment</h2>
          <p>Officer assessment for exaggerated or misleading package quantity impression. AI may assist with evidence, but the officer records the legal determination.</p>
        </div>
        <strong>{complete ? "Assessment recorded" : "Assessment required"}</strong>
      </div>

      <div className="rule23-assessment-fields">
        <label>
          <strong>Was the package visually inspected for Rule 23?</strong>
          <select value={assessment.visualInspectionPerformed ? "yes" : "no"} onChange={(event) => update("visualInspectionPerformed", event.target.value === "yes")}>
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </label>

        <label>
          <strong>Does the package give an exaggerated or misleading impression of quantity?</strong>
          <select value={assessment.deceptivePackage === null ? "" : assessment.deceptivePackage ? "yes" : "no"} onChange={(event) => update("deceptivePackage", event.target.value === "" ? null : event.target.value === "yes")}>
            <option value="">Select officer assessment</option>
            <option value="no">No, not misleading</option>
            <option value="yes">Yes, potentially misleading</option>
          </select>
        </label>

        {potentiallyDeceptive && <>
          <label>
            <strong>Does the contained quantity agree with the declared quantity?</strong>
            <select value={assessment.quantityAgreesWithDeclaration === null ? "" : assessment.quantityAgreesWithDeclaration ? "yes" : "no"} onChange={(event) => update("quantityAgreesWithDeclaration", event.target.value === "" ? null : event.target.value === "yes")}>
              <option value="">Select assessment</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>

          <label>
            <strong>Are larger package dimensions justified by commodity protection or machine-filling requirements?</strong>
            <select value={assessment.largerDimensionsJustified === null ? "" : assessment.largerDimensionsJustified ? "yes" : "no"} onChange={(event) => update("largerDimensionsJustified", event.target.value === "" ? null : event.target.value === "yes")}>
              <option value="">Select assessment</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>

          <label>
            <strong>Was the package repacked and relabelled as required?</strong>
            <select value={assessment.repackedAndRelabeled === null ? "" : assessment.repackedAndRelabeled ? "yes" : "no"} onChange={(event) => update("repackedAndRelabeled", event.target.value === "" ? null : event.target.value === "yes")}>
              <option value="">Select assessment</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
        </>}

        <div className="status-message">
          {assessment.deceptivePackage === false
            ? "Rule 23 will pass after the visual inspection is recorded."
            : potentiallyDeceptive
              ? "Potential Rule 23 concern recorded. The Rules Engine will evaluate the additional conditions."
              : "Rule 23 remains Unable to Verify until the officer records a visual assessment."}
        </div>
      </div>
    </section>
  );
}
