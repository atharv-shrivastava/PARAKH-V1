# PARAKH API Specification

## 1. API principles

The API is the contract between the React/Vite client and the Node.js/Express backend. Protected resources require authentication/authorization. The current base path is `/api`.

## 2. Current route groups

```text
/api/auth
/api/categories
/api/products
/api/shops
/api/rules
/api/admin
/api/analytics
/api/translate
/api/products/ecommerce-ocr
/api/ocr
```

The running source code is authoritative for exact endpoint paths and payload details.

## 3. Authentication

Authentication and authorization are handled by the backend. Secrets must never be committed.

## 4. Categories and products

Category APIs provide the hierarchical catalogue:

`Category → Subcategory → Product Type → Brand → Product → Variant`

Product APIs support registration, detail/update/delete where authorized, hierarchy relationships, and inspection-linked information.

## 5. Shops

Shop APIs support listing/search, creation, detail, inspection history, products, statistics, and authorized deletion. Statistics are derived from stored inspection data.

## 6. Scan / OCR endpoint

Current scan endpoint:

`POST /api/ocr/analyze`

The endpoint accepts multipart package images and optional category options. Current processing flow:

```text
Images
  ↓
RapidOCR
  ↓
OCR evidence + confidence + geometry
  ↓
Deterministic field reconciliation
  ↓
Gemini semantic interpretation / optional semantic consensus
  ↓
Structured result
  ↓
DataKart GTIN verification
  ↓
Evidence confidence fusion
```

The response contains a `result` object with extracted fields and metadata, together with provider/timing information and warnings.

## 7. DataKart verification

DataKart is a separate product-reference registry. In the current V1 frontend integration, the API route is:

`GET /api/datakart/gtin/:gtin`

The route looks up an active DataKart product by GTIN and returns the registered product reference. A missing record returns `404` and provider/database failures return an appropriate gateway/server error.

DataKart does not evaluate Legal Metrology compliance.

## 8. Evidence confidence response

For recognized structured fields, the backend can attach:

```json
{
  "confidence": 0.96,
  "evidenceConfidence": 0.96,
  "confidenceSources": {
    "datakart": 1,
    "gemini": 0.90,
    "rapidocr": 0.95
  },
  "verification": "MATCH",
  "verificationIcon": "✓",
  "confidenceLabel": "Evidence confidence"
}
```

The default weighting is:

```text
DataKart agreement  = 50%
Gemini confidence   = 30%
RapidOCR confidence = 20%
```

If a source is unavailable, its weight is omitted and the remaining weights are renormalized.

The confidence is an evidence-fusion indicator, not a calibrated probability and not legal certainty.

Verification values are:

- `MATCH` / `✓`
- `MISMATCH` / `✕`
- `UNVERIFIED` / `?`

## 9. Compliance and rules

Rule APIs expose the configurable compliance rule set. Legal logic belongs in the backend rules layer, not in React or an LLM. Manual violations must remain auditable.

## 10. Analytics

Analytics are derived from real inspection records and include inspection trends, totals, violation totals, highest-violation shop/source, brand, and rule. User views are scoped appropriately; admin views can be platform-wide.

## 11. E-commerce

`/api/products/ecommerce-ocr` handles online listing analysis.

## 12. Administration

`/api/admin` contains authorized administrative operations.

## 13. Error handling

Preferred shape:

```json
{"error":{"code":"VALIDATION_ERROR","message":"Human-readable explanation","details":{}}}
```

Do not return stack traces or secrets to clients.

## 14. Upload validation

The OCR upload path validates supported MIME types, image count, and file size. Current accepted image formats are JPEG, PNG, and WebP.

## 15. Caching

The frontend uses short-lived GET caching. Persisted mutations invalidate relevant cache entries.

## 16. Versioning note

Older documentation described a planned `/api/v1` contract. The current implementation uses `/api`.