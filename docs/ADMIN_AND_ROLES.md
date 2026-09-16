# PARAKH V1 Administration and Roles

**SIH Problem Statement 26034**

## Purpose

Administrative functionality is separated from ordinary inspection work because configuration and verification actions can affect the behavior of the platform and the interpretation of stored inspection information.

The exact authorization behavior in the source branch is authoritative.

## 1. Administrative areas

The admin area covers platform-level management such as:

- user/access administration where implemented
- compliance-rule administration
- global category management
- product administration
- inspection administration
- analytics/intelligence oversight
- batch-incident review
- batch-alert verification
- batch-alert resolution

## 2. Compliance rule administration

Administrators can manage configurable `ComplianceRule` definitions where the current application exposes that capability.

Typical responsibilities include:

- create rule definitions
- edit rule definitions
- enable/disable configured rules where supported
- maintain rule metadata
- associate rules with relevant compliance fields/categories where supported
- review rule status

The Rules Engine consumes configured rule definitions. Legal requirements are not intended to live only inside an AI prompt.

## 3. Global product-category administration

Administrators can manage reusable category definitions that ordinary product registration consumes.

Capabilities include:

- add categories
- organize parent/child relationships
- designate final categories
- edit category information
- maintain a reusable global taxonomy
- support product registration against the current hierarchy

## 4. Product administration

Administrative product operations can include:

- product records
- manufacturer/brand information
- category associations
- GTIN/reference information
- pack/variant information
- inspection associations

Product administration should remain distinct from an individual inspection event.

## 5. Inspection administration

Authorized administrative views can provide oversight of stored inspections and their associated compliance information.

This can include:

- inspection lookup
- inspection review
- product/shop relationships
- compliance findings
- verification status
- batch relationships
- report access

## 6. Batch incident administration

Batch safety uses a review process before a reported incident becomes a verified alert.

```text
Incident reported
       ↓
Administrative review
       ↓
Verify
       ↓
Verified batch alert
       ↓
Active warning
       ↓
Resolve
```

The administrator review boundary is intentional. AI should not autonomously promote an incident into a verified safety alert.

## 7. Analytics and intelligence administration

Administrative users can access platform-wide intelligence where authorized.

Analytics dimensions include:

- manufacturer
- product
- GTIN
- batch
- violation
- city/district
- state
- date range
- verification status

The dashboard can use dynamic filters and graph datasets derived from the filtered inspection population.

## 8. Roles and authorization principles

The application is role-aware.

General principle:

```text
Frontend visibility
       ≠
Security boundary

Backend authorization
       =
Security boundary
```

An operation that is restricted to an authorized role must also be checked by the backend even when the frontend hides the relevant control.

## 9. Officer-facing controls

Ordinary inspection users/officers can work with the inspection workflow according to their assigned authorization.

Typical officer actions include:

- start an inspection
- upload/capture package images
- review OCR/AI evidence
- review GTIN/reference evidence
- review rule findings
- edit extracted fields
- add manual violations
- provide Rule 23 assessment information
- accept/correct/reject findings
- save/register the inspection
- generate/access reports where permitted

## 10. Future administration scope

Future administrative expansion can include:

- hierarchical role templates
- state/district scoped officers
- officer assignment and review queues
- organization/department tenancy
- audit-log viewer
- rule version approval workflow
- regulatory update approval
- GTIN/reference data administration
- offline synchronization oversight
- data-retention controls
- security policy controls
- configurable notification policies

These are future capabilities unless implemented and verified in the current source tree.

## 11. Auditability

Administrative actions that change compliance configuration, categories, users, or verified safety alerts should be auditable in a production deployment.

Potential audit data includes:

- actor/user
- timestamp
- action
- affected record
- previous value
- new value
- reason/comment where appropriate
- source/client information where appropriate

Audit expansion is part of production-oriented future scope unless already implemented in the current code.

## 12. Security expectations

Never rely on UI-only restrictions for sensitive operations. Protect administrative APIs, validate input, keep secrets out of the client, and avoid exposing internal implementation details in user-facing errors.
