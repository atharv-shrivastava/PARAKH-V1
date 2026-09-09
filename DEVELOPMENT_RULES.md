# PARAKH Development Rules

This file is the contract for human developers and AI coding tools contributing to PARAKH.

## 1. Source of truth
`README.md` gives the overview. `PROJECT_SPEC.md` defines functional requirements. `ARCHITECTURE.md` defines the current technical architecture. Working source code is authoritative for implemented behavior.

## 2. Before coding
Inspect existing code and read the relevant specification before editing. Reuse existing modules and preserve the current end-to-end inspection path.

## 3. Feature parity
Keep the inspection workflow usable across phone, tablet, laptop, and desktop.

## 4. AI coding rules
Inspect before editing. Avoid unnecessary dependencies and duplicated logic. Keep API contracts synchronized. Never invent legal requirements. Never commit secrets. Do not describe an integration as live unless the code actually invokes it.

## 5. Frontend
Current stack: React + Vite + React Router using JSX/JavaScript.

Preserve shared components, theme variables, responsive behavior, loading/empty/error states, accessibility, and reduced-motion support.

## 6. Backend
Current stack: Node.js + Express.

Keep routes understandable, validate server-side, preserve authentication/authorization, and keep reusable business logic out of UI code.

## 7. OCR architecture
RapidOCR is the primary OCR/detection layer in V1.

Do not silently replace RapidOCR with another OCR provider. OCR evidence should retain confidence and geometry where available. Deterministic reconciliation should remain evidence-driven.

## 8. Semantic AI architecture
Gemini is the default semantic interpretation provider. Optional Cloudflare semantic providers may be enabled through configuration.

AI interprets package information and semantic relationships. It does not determine Legal Metrology compliance.

## 9. Evidence confidence
Current field-level weighting is:

```text
50% DataKart agreement
30% Gemini confidence
20% RapidOCR confidence
```

Treat this as Evidence Confidence, not as a calibrated probability or legal certainty.

If a source is unavailable, omit its component and renormalize the remaining weights. Never duplicate one provider's confidence to compensate for a missing source.

## 10. DataKart
DataKart is a separate product-reference registry. Use extracted GTIN/barcode to compare registered product fields against the current inspection fields.

DataKart is not the compliance engine. A DataKart match is supporting evidence; a mismatch is a verification warning; an unavailable/unregistered field is unverified.

Do not move DataKart into the PARAKH application database merely to simplify an implementation unless the architecture is deliberately redesigned.

## 11. Database
Current persistence: PostgreSQL through Prisma.

Use migrations, preserve inspection history, separate catalogue data from inspection events, and avoid unnecessary full-table queries.

## 12. Legal Metrology
Legal requirements belong in the configurable compliance/rules layer. Do not hard-code legal logic into React or hide deterministic checks inside LLM prompts. Maintain rule source/reference and version.

## 13. AI safety
AI must not fabricate fields. Unknown stays unknown. AI confidence is not legal certainty. Insufficient evidence should trigger manual review or unable-to-determine states.

## 14. Evidence preservation
Preserve original OCR/AI extraction and source evidence when an officer edits or verifies a result. Do not overwrite the original source value without retaining provenance.

## 15. Security
Never commit API keys, passwords, production DB credentials, private certificates, or real sensitive inspection data. Use environment variables. Never expose privileged database credentials to the browser.

## 16. Uploads
Validate file type, size, count, and dimensions server-side.

## 17. Errors
User-facing errors should be understandable. Provider/model/database diagnostics belong in server logs. Provider failures should identify provider/model where practical.

## 18. Performance
Prefer targeted queries, bounded external-provider timeouts, short-lived GET caching, mutation-triggered invalidation, parallel independent work where safe, and avoiding unnecessary page remounts.

## 19. Testing
Test new business logic where practical. Compliance rules should have explicit unit tests. Evidence-confidence logic should test match, mismatch, missing-registry, and source-unavailable cases. API behavior should be testable independently of the frontend.

## 20. Git
Use focused commits:
`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
Use feature branches and pull requests for team work where practical.

## 21. No fake functionality
Do not present mocks as live AI, registry verification, or compliance services. Do not claim a score is statistically calibrated unless it has actually been evaluated and calibrated.

## 22. Documentation
When architecture, API, database, AI, UI, confidence, or compliance behavior changes, update the relevant documentation in the same development cycle.
