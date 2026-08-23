# Implementation Plan: Daily Malaysia Income Totals

## Overview

Implement the validated design as a minimal TypeScript monorepo change: strict date-only backend queries, shared owned filtering, exact daily totals, date-only frontend filters, coordinated fail-closed dashboard loading, and totals-only Malaysian-midnight refresh. Reuse the existing Prisma schema, Temporal polyfill, Vitest, Testing Library, Supertest, and fast-check. Do not create a Prisma migration, mutate/backfill/delete stored delivery data, modify delivery CRUD semantics, or change `.kiro/specs/halal-or-not`.

## Tasks

- [x] 1. Add the backend date-only and owned-filter domain
  - [x] 1.1 Create the typed income query utility and shared owned-record filter builder
    - Add canonical `YYYY-MM-DD` parsing that rejects timestamps, impossible/overflow dates, and noncanonical strings; normalize a lone boundary to a one-day range and reject reversed ranges.
    - Add injected `Clock` support for `Asia/Kuala_Lumpur` today and host-timezone-independent half-open Prisma `DATE` carriers (`gte` start, `lt` day-after-end).
    - Implement `buildOwnedEntryWhere` with mandatory `userId`, optional date/status predicates, and `cash`/`digital`/`both` payment semantics for reuse by entries and totals.
    - Keep this module pure and read-only; do not alter Prisma schema or add migration/data-operation files.
    - _Requirements: 1.1, 1.2, 1.4, 2.1, 2.2, 2.4, 2.5, 4.1, 4.2, 6.4, 6.5_
  - [ ]* 1.2 Write unit tests for strict date parsing, Malaysian date conversion, and owned filter construction
    - Cover leap dates, impossible dates, timestamps, canonical formatting, one-sided ranges, reversed ranges, inclusive end conversion, Malaysian 16:00 UTC day boundaries, and host-`TZ` independence.
    - Assert ownership is always present and `both` adds no payment predicate.
    - _Requirements: 1.4, 2.2, 2.3, 4.1, 4.2, 6.4, 6.5_
  - [ ]* 1.3 Write the property test for entry-date dominance
    - **Property 1: Entry Date Dominance**
    - Generate independent `entryDate`, `createdAt`, and `timestamp` values and verify membership depends only on stored `entryDate`.
    - **Validates: Requirements 1.1, 1.2**
  - [ ]* 1.4 Write the property test for inclusive explicit date selection
    - **Property 3: Inclusive Explicit Date Selection**
    - Compare generated single/range selections against an inclusive civil-date reference model, including corrected formerly reversed ranges.
    - **Validates: Requirements 2.1, 2.2, 2.8**
  - [ ]* 1.5 Write the property test for conjunctive filter composition
    - **Property 4: Conjunctive Filter Composition**
    - Generate owners, dates, statuses, and payment states and assert exact identifier-set equality with the reference conjunction.
    - **Validates: Requirements 2.4, 2.5, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3**

- [x] 2. Refactor `IncomeService` reads and exact totals
  - [x] 2.1 Update entry paging and totals to use the shared builder and injected clock
    - Keep entries historical when dates are absent; default only totals to request-time `Asia/Kuala_Lumpur` today.
    - Use one identical `where` for count and page queries, deterministic `entryDate desc`, `timestamp desc`, `id asc` ordering, then `skip`/`take`.
    - Add `paymentType` to totals and fold matching rows with `Prisma.Decimal` (or integer cents): status totals use fare plus nullable cash, cash totals use nullable cash, and digital totals use fare; return four numeric zeros for an empty set.
    - Ensure all feature read paths call only read APIs and preserve existing public response shapes and CRUD behavior.
    - _Requirements: 1.3, 3.1, 3.2, 3.3, 3.4, 3.5, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 6.2, 6.5, 6.7, 6.8, 6.9_
  - [ ]* 2.2 Write focused `IncomeService` unit tests
    - Use an injected clock and mocked Prisma reads to cover default Malaysian today, historical default entries, explicit ranges, status/payment filters, exact scale-two arithmetic, null cash, empty matches, deterministic paging, and identical count/page predicates.
    - Assert no create/update/delete/raw mutation method is invoked.
    - _Requirements: 1.3, 3.1, 3.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 6.2, 6.7, 6.8, 6.9_
  - [ ]* 2.3 Write the property test for default Malaysian-day totals
    - **Property 2: Default Malaysian-Day Totals**
    - Compare generated instants and entries with an `Asia/Kuala_Lumpur` current-day reference aggregation, including both midnight boundaries.
    - **Validates: Requirements 1.3, 1.4**
  - [ ]* 2.4 Write the property test for default scope separation and restoration
    - **Property 5: Default Scope Separation and Restoration**
    - Verify clearing dates restores historical entries, current-Malaysia-day totals, retained non-date filters, and offset zero.
    - **Validates: Requirements 3.1, 3.2, 3.6, 3.7**
  - [ ]* 2.5 Write the property test for exact four-card aggregation
    - **Property 6: Exact Four-Card Aggregation**
    - Generate scale-two monetary records and compare all four totals exactly with a decimal reference fold, including cash-only and empty sets.
    - **Validates: Requirements 2.7, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9**
  - [ ]* 2.6 Write the property test for user isolation before filtering and aggregation
    - **Property 9: User Isolation Before All Other Operations**
    - Generate mixed-owner records and verify each user’s totals and pages match a reference model that removes other owners first.
    - **Validates: Requirements 6.4, 6.5**

- [x] 3. Enforce typed query validation at both backend routes
  - [x] 3.1 Wire the shared parser into income entries and analytics totals routes
    - Accept only date-only strings, normalized one-day/range filters, valid status/payment values, integer `limit` 1–100, and integer `offset` 0–2147483647 with defaults 50/0.
    - Validate before service invocation, return the existing safe `400 { error, details }` shape, pass `paymentType` to totals, and pass no absent date so the service owns defaulting.
    - Remove route-local `Date` construction and untyped filter objects while retaining endpoint paths and response shapes.
    - _Requirements: 2.3, 2.6, 3.8, 4.1, 4.2, 6.6, 6.11_
  - [ ]* 3.2 Add Supertest route validation and filter-contract tests
    - Cover malformed/noncanonical/impossible dates, reversed ranges, one-sided normalization, status/payment values, pagination minima/maxima and out-of-range/fractional inputs.
    - Assert invalid requests make no service/database call and both endpoints pass identical explicit filter contracts, including `paymentType`.
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 4.1, 4.2, 6.6, 6.11_
  - [ ]* 3.3 Write the property test for pagination consistency and bounds
    - **Property 10: Pagination Consistency and Bounds**
    - Compare generated valid pages with deterministic reference slices/counts and generated invalid values with fail-before-query behavior.
    - **Validates: Requirements 6.6, 6.7, 6.8, 6.9, 6.11**

- [x] 4. Establish the frontend date-only filter and API contract
  - [x] 4.1 Update dashboard API types, serialization, cancellation, and safe validation errors
    - Use shared date-only string filter types for entries and totals, serialize strings unchanged, send analytics `paymentType`, preserve explicit numeric zero, and accept optional `AbortSignal`.
    - Normalize backend validation details without exposing unsafe server content; retain existing unauthorized behavior.
    - _Requirements: 2.1, 2.2, 2.5, 3.4, 3.5, 4.3, 6.6, 6.11_
  - [x] 4.2 Refactor `FilterPanel` to emit date-only draft/apply results
    - Keep native input strings, normalize a lone boundary, reject reversed ranges before requests, preserve non-date selections on invalid apply, and emit clear/apply transitions without `Date`, `toISOString`, or host-local conversion.
    - Keep draft state separate from applied state so editing does not query and corrected valid input applies automatically.
    - _Requirements: 2.3, 2.8, 3.6, 3.7, 6.10_
  - [ ]* 4.3 Add frontend API and `FilterPanel` unit tests
    - Assert unchanged date-only query strings, totals payment serialization, `offset=0`, abort propagation, validation-detail normalization, lone-date normalization, reversed-range fail-closed output, corrected apply, and clear behavior.
    - _Requirements: 2.3, 2.5, 2.8, 3.6, 3.7, 4.3, 6.10, 6.11_

- [ ] 5. Implement coordinated fail-closed dashboard loading
  - [x] 5.1 Add typed dashboard data-state and request-generation coordination
    - Model loading/ready/validation-error/load-error states and separate refresh errors; add monotonically increasing generations and abort ownership so stale or unmounted requests cannot commit.
    - Implement a coordinated entries/totals load that waits for both settlements and atomically commits both only on complete success.
    - _Requirements: 2.3, 2.6, 3.8, 6.11_
  - [x] 5.2 Wire filter, pagination, delete-refresh, and fail-closed rendering in `DashboardPage`
    - Reset offset on every filter select/change/clear, retain requested offset for pagination-only actions, and remove active dates while retaining non-date filters after invalid range apply.
    - Replace both totals and entries with one validation/load error when appropriate; never render a partial response, while preserving state and existing authentication/delete behavior.
    - _Requirements: 2.3, 2.6, 2.7, 2.8, 3.6, 3.7, 3.8, 3.9, 6.10, 6.11_
  - [ ]* 5.3 Add dashboard integration tests for atomic loading and date-scope transitions
    - Mock both APIs to test initial/filter/pagination/delete loads, one-side failures after both settle, empty success, clear-to-default scopes, corrected-range reload, retained filters, and stale generation/unmount cancellation.
    - _Requirements: 2.3, 2.6, 2.7, 2.8, 3.6, 3.7, 3.8, 3.9, 6.10, 6.11_
  - [ ]* 5.4 Write the property test for filter-change pagination transitions
    - **Property 11: Filter-Change Pagination Transition**
    - Generate filter and navigation action sequences and assert the exact offset used by each next entry request.
    - **Validates: Requirements 3.9, 6.10**
  - [ ]* 5.5 Write the property test for invalid or inconsistent loads failing closed
    - **Property 12: Invalid or Inconsistent Loads Fail Closed**
    - Generate reversed ranges and endpoint settlement combinations; assert no query for local invalidity and no partial commit for coordinated failures.
    - **Validates: Requirements 2.3, 2.6, 3.8**

- [x] 6. Add totals-only Malaysian midnight refresh
  - [x] 6.1 Implement the injectable Malaysia-date scheduler and bounded retry controller
    - Compute Malaysian dates with `Intl.DateTimeFormat(..., { timeZone: "Asia/Kuala_Lumpur" })`, schedule/recheck the next midnight, and support visibility/resume catch-up.
    - Trigger only when no explicit date is active; serialize one totals-only attempt plus at most three retries 30 seconds after rejection, keep pending requests alive beyond 60 seconds, and cancel timers/generations on success, filter changes, or unmount.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_
  - [x] 6.2 Integrate totals-only midnight refresh with the dashboard
    - Refresh totals atomically with current non-date filters, never request or alter entries, preserve the last successful totals during failures, and show a separate refresh error after the final rejection.
    - Ensure explicit dates disable midnight scope changes and clearing dates reestablishes default scheduling through the normal coordinated load.
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 5.7_
  - [ ]* 6.3 Add fake-timer unit tests for midnight scheduling and cancellation
    - Use `vi.useFakeTimers()` plus injected clock/timers to cover midnight boundaries, visibility catch-up, totals-only calls, +30/+60/+90 retry traces, stop-on-success, final error timing, explicit-date suppression, cancellation, and unresolved requests beyond 60 seconds without overlap.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_
  - [ ]* 6.4 Write the property test for the Malaysian midnight refresh state machine
    - **Property 7: Malaysian Midnight Refresh State Machine**
    - Generate filter states, date transitions, timer progressions, and settlement traces and compare calls/state with the bounded-retry reference machine.
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7**

- [x] 7. Validate database invariance, user isolation, and regressions
  - [x] 7.1 Add database-backed read-path integration coverage
    - Seed multiple users, Malaysian boundary dates, statuses, payment states, and pagination ties; verify owned exact totals, historical default entries, inclusive selected end dates, deterministic slices, and count-before-pagination.
    - Snapshot all delivery row identifiers/field values before and after successful/failed dashboard reads and simulated day changes; assert exact invariance and no production create/update/delete/raw mutation path.
    - Keep fixture setup/cleanup transaction-scoped to the test database; do not add a Prisma migration, schema change, backfill, truncate, or destructive production-data command.
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 3.1, 3.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 6.8, 6.9_
  - [ ]* 7.2 Write the property test for storage invariance under reads and day changes
    - **Property 8: Storage Invariance Under Reads and Day Changes**
    - Generate successful/failed read sequences and Malaysian day transitions and compare the complete final delivery-row multiset with the initial snapshot.
    - **Validates: Requirements 6.1, 6.2, 6.3**
  - [ ]* 7.3 Add targeted backend and frontend regression tests
    - Preserve existing delivery create/edit/delete refresh, authentication/unauthorized handling, report UI, response shapes, and unrelated halal-or-not behavior without editing its spec or implementation.
    - Run targeted backend/frontend Vitest suites in single-run mode, TypeScript builds, Prisma schema validation, and the database integration suite; verify the working diff contains no Prisma migration/schema or destructive-data operation.
    - _Requirements: 3.8, 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP; implementation tasks are required.
- Property tests should run at least 100 cases and include `Feature: daily-malaysia-income-totals, Property N: ...` tags/comments.
- No task authorizes a Prisma migration, schema/data rewrite, backfill, truncate, production delete/update, dependency addition, endpoint replacement, or modification to `.kiro/specs/halal-or-not`.
- Test fixtures may use only the repository’s existing isolated test-database lifecycle; feature production code remains read-only for dashboard operations.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "1.2", "1.3"] },
    { "id": 2, "tasks": ["3.1", "2.2", "2.3", "2.5", "1.4"] },
    { "id": 3, "tasks": ["4.1", "3.2", "3.3", "2.6", "1.5"] },
    { "id": 4, "tasks": ["4.2", "5.1", "2.4"] },
    { "id": 5, "tasks": ["4.3", "5.2", "6.1"] },
    { "id": 6, "tasks": ["5.3", "5.4", "5.5", "6.2"] },
    { "id": 7, "tasks": ["6.3", "6.4", "7.1"] },
    { "id": 8, "tasks": ["7.2"] },
    { "id": 9, "tasks": ["7.3"] },
    { "id": 10, "tasks": ["8"] }
  ]
}
```
