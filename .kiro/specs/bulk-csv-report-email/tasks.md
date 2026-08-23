# Implementation Plan: Bulk CSV Report Email

## Overview

Implement the feature incrementally in the existing TypeScript npm-workspace monorepo: establish pinned dependencies and PostgreSQL invariants first, then add backend domain services and authenticated APIs, durable report processing and signed provider events, the dashboard panel, and automated/operational validation. Existing income CRUD, analytics, filtering, pagination, and synchronous CSV download behavior remain regression-protected.

## Tasks

- [x] 1. Establish report dependencies, persistence, and shared contracts
  - [x] 1.1 Pin report and test dependencies and add non-watch scripts
    - Update workspace manifests and `package-lock.json` using `--save-exact`: backend runtime `@js-temporal/polyfill@0.5.1` and `resend@6.0.2`; backend dev `fast-check@4.9.0` and `csv-parse@6.1.0`; frontend dev `fast-check@4.9.0`, `@testing-library/user-event@14.6.4`, `@playwright/test@1.57.0`, and `@axe-core/playwright@4.11.0`.
    - Add single-run report, integration, worker, and browser test scripts without changing existing workspace commands to watch mode.
    - _Requirements: 2.1, 5.3, 6.1, 8.1, 8.5_

  - [x] 1.2 Add Prisma report models and an authoritative SQL migration
    - Extend `packages/backend/prisma/schema.prisma` with account `timeZone`, report enums, `ReportRequest`, immutable snapshot/entry, attachment, delivery, provider-event, and leased `ReportJob` models and relations from the design.
    - Create a migration that defaults existing users to `Asia/Kuala_Lumpur`, creates all constraints/indexes, adds the partial unique active-request index and `(user_id, entry_date)` delivery-entry index, and preserves all existing rows.
    - Encode one request-to-one artifact/job constraints, retry linkage, provider/idempotency uniqueness, decimal scales, date-only columns, cascades, and job lease/attempt/availability fields.
    - _Requirements: 1.6, 1.7, 3.8, 3.9, 3.10, 6.5, 6.11, 6.12, 6.13, 7.8_

  - [x] 1.3 Create shared report domain contracts and safe error types
    - Add backend report type/status/stage constants, commands, wire DTOs, snapshot/attachment/provider interfaces, injected clock/ID abstractions, and exhaustive typed domain errors under `packages/backend/src/reporting/`.
    - Keep dates as strict `YYYY-MM-DD` strings at API boundaries, money as `Prisma.Decimal` in report paths, and public failures limited to stable code/stage/message/field errors.
    - _Requirements: 2.5, 4.6, 4.17, 6.7, 6.10, 7.4, 7.5, 7.6, 7.10, 7.11_

  - [x]* 1.4 Add migrated-PostgreSQL schema and constraint integration tests
    - Apply the migration to a disposable PostgreSQL database and test timezone backfill, one-active-request concurrency, one-to-one artifacts/jobs, retry foreign keys, provider-event uniqueness, and delivery-entry index presence; add reversible migration verification for CI.
    - Verify failed snapshot transactions cannot leave partial headers/rows and cannot mutate source delivery entries.
    - _Requirements: 1.7, 3.8, 3.11, 3.12, 6.11, 6.12_
- [x] 2. Implement period resolution, request lifecycle, and authenticated APIs
  - [x] 2.1 Implement the pure `ReportPeriodResolver`
    - Use `Temporal.PlainDate` with overflow rejection, supported years `0001`–`9999`, an injected clock, and the server-stored IANA timezone to validate current/future boundaries and resolve Monday–Sunday or first–last month dates.
    - Return typed missing, malformed, nonexistent, pre-range, future-date, and report-type errors for reuse by preview and creation.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 7.2, 7.3_

  - [x]* 2.2 Write the property test for weekly boundaries
    - **Property 2: Weekly calendar boundaries**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment in a dedicated test file; generate leap, month, year, and timezone/current-date boundaries.
    - **Validates: Requirements 2.1, 2.2**

  - [x]* 2.3 Write the property test for monthly boundaries
    - **Property 3: Monthly calendar boundaries**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment in a dedicated test file; compare against an independent Gregorian month-length model.
    - **Validates: Requirements 2.3, 2.4**

  - [x]* 2.4 Write the property test for rejected reference dates
    - **Property 4: Invalid references cannot replace valid resolution**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment; model preserved prior resolution for absent, out-of-range, nonexistent, and timezone-future inputs.
    - **Validates: Requirements 2.6, 2.7**

  - [x] 2.5 Implement `ReportRequestService` and transactional lifecycle operations
    - Reload the authenticated user, derive recipient/timezone/period, create request plus outbox job atomically, enforce `(userId, clientRequestId)` replay semantics and the active-request constraint, and distinguish replay, payload conflict, and in-progress responses.
    - Implement owned active/get DTOs, idempotent retry linked to an unchanged failed request, compare-and-set nonterminal/terminal transitions, typed failure recording, and create/retry/terminal `AuditLog` writes.
    - Never accept client user, recipient, timezone, period boundaries, status, or failure fields.
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 2.5, 3.11, 3.12, 3.13, 6.5, 6.6, 6.8, 6.9, 6.11, 6.14, 7.8, 7.11, 7.12_

  - [x]* 2.6 Write the property test for idempotent creation and one active request
    - **Property 1: Idempotent creation and one active request**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment; vary duplicate deliveries, commands, users, and nonterminal states against a database-backed or transactional model.
    - **Validates: Requirements 1.6, 1.7**

  - [x]* 2.7 Write the property test for invalid command persistence isolation
    - **Property 21: Invalid commands have no persistence effect**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment; assert typed errors and zero request/artifact/job rows.
    - **Validates: Requirements 7.2, 7.3**

  - [x]* 2.8 Write the property test for immutable retries
    - **Property 23: Retry creates a new immutable attempt**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment; replay retry commands and compare every original field before/after.
    - **Validates: Requirements 7.8**

  - [x] 2.9 Add report routes, validation, DTO mapping, and application wiring
    - Create authenticated resolve, create, active, owned status, and retry routes with the exact design URLs and `200/202/204/400/401/404/409` contracts; return `404` for cross-user IDs and include safe HTTP correlation IDs.
    - Add a centralized report error mapper with field errors, active-request DTO support, and fixed secret-free unexpected errors; mount routes in `src/index.ts` without altering existing routes.
    - _Requirements: 1.6, 1.7, 2.5, 2.6, 2.7, 7.1, 7.2, 7.3, 7.8, 7.10_

  - [x]* 2.10 Add resolver, request-service, and API integration examples
    - Test known week/month/leap/year-0001/current-date cases, identical and conflicting keys, concurrent active requests, session failures with zero rows, ownership isolation, active/status DTOs, retry linkage, and terminal no-ops using Supertest plus migrated PostgreSQL.
    - _Requirements: 1.4, 1.6, 1.7, 2.1–2.7, 6.14, 7.1, 7.2, 7.3, 7.8_

- [x] 3. Implement exact report selection and immutable snapshots
  - [x] 3.1 Implement `ReportDataService` and snapshot transaction
    - Query `DeliveryEntry` only by authenticated `userId` and inclusive `entryDate`, with no status/cash/dashboard filters or pagination, ordered by date/timestamp descending and ID ascending.
    - In one repeatable-read transaction, copy exact Decimal/date/timestamp values into one snapshot and derive count/totals only from copied rows; expose snapshot create/read but no update API.
    - Roll back any partial snapshot, preserve source entries, and mark the request with the correct safe failure stage in a follow-up transaction.
    - _Requirements: 3.1–3.13, 4.9, 4.10, 4.11–4.16_

  - [x]* 3.2 Write the property test for exact report set filtering
    - **Property 5: Report selection is exact set filtering**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment; use an independent set-filter model over mixed owners, boundary dates, statuses, cash flags, permutations, and collections above dashboard page size.
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

  - [x]* 3.3 Write the property test for exact immutable snapshots
    - **Property 6: Snapshot is an exact immutable source**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment; mutate/delete/insert source rows after snapshot and compare snapshot-derived details, totals, and bytes.
    - **Validates: Requirements 3.8, 3.9, 3.10**

  - [x]* 3.4 Add snapshot and data-scope PostgreSQL integration tests
    - Cover mixed users, both period boundaries, status/cash variations, zero rows, datasets above page size, deterministic ties, injected query/snapshot failures, transaction rollback, unchanged source entries, and output after source mutation/deletion.
    - _Requirements: 3.1–3.13, 7.4, 7.11, 7.12_
- [x] 4. Generate exact, safe, immutable CSV attachments
  - [x] 4.1 Implement the pure `CsvReportGenerator`
    - Generate only the designed metadata, aligned detail header/rows, and summaries from a persisted snapshot; use Decimal folds, deterministic ordering, UTC second timestamps, fixed two-decimal money, lower-case booleans, and required empty/zero cash behavior.
    - Implement formula-trigger neutralization before RFC-style quoting, UTF-8 encoding, CRLF termination including the final row, SHA-256, byte size, exact filename/media type, injected completion clock, and typed null-required-cash/encoding failures without snapshot mutation.
    - _Requirements: 4.1–4.18, 5.1–5.8_

  - [x]* 4.2 Write the property test for CSV schema and detail bijection
    - **Property 7: CSV report schema and detail bijection**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment; parse with `csv-parse`, independently inspect section cardinality/alignment, and compare one row per snapshot entry.
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.11**

  - [x]* 4.3 Write the property test for deterministic detail ordering
    - **Property 8: Detail ordering is deterministic**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment; test arbitrary input permutations and date/timestamp/source-ID ties.
    - **Validates: Requirements 4.4, 4.5**

  - [x]* 4.4 Write the property test for entry money rendering
    - **Property 9: Entry money rendering and calculation**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment using exact scale-two Decimal values, zero cash, false flags with stored cash, and independent total calculations.
    - **Validates: Requirements 4.6, 4.7, 4.8, 4.9, 4.10**

  - [x]* 4.5 Write the property test for summary folds
    - **Property 10: Summary values equal exact snapshot folds**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment; compare against independent Decimal folds and include empty snapshots.
    - **Validates: Requirements 4.11, 4.12, 4.13, 4.14, 4.15, 4.16**

  - [x]* 4.6 Write the property test for canonical temporal formatting
    - **Property 11: Canonical temporal formatting**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment over supported dates and arbitrary instants; parse values back at required precision.
    - **Validates: Requirements 4.17**

  - [x]* 4.7 Write the property test for missing required cash failure
    - **Property 12: Missing required cash fails without mutation**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment; assert typed failure, no attachment result, and deep snapshot equality.
    - **Validates: Requirements 4.18**

  - [x]* 4.8 Write the property test for UTF-8 CSV round trips
    - **Property 13: UTF-8 CSV round trip**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment using arbitrary Unicode, commas, quotes, CR/LF, and control characters; use an independent parser and assert final CRLF.
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

  - [x]* 4.9 Write the property test for formula neutralization
    - **Property 14: Formula-trigger neutralization**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment over every trigger/non-trigger prefix and already-apostrophized text.
    - **Validates: Requirements 5.5**

  - [x]* 4.10 Write the property test for attachment identity and content closure
    - **Property 15: Attachment identity and content closure**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment; independently allowlist parsed keys and verify exact filenames/media type.
    - **Validates: Requirements 5.6, 5.7, 5.8**

  - [x]* 4.11 Add focused CSV generator unit and golden tests
    - Cover the canonical design example, empty report, zero/null cash, timestamp truncation, every escape/formula case, deterministic hash, exact UTF-8 byte count, and final CRLF without duplicating property assertions.
    - _Requirements: 4.1–4.18, 5.1–5.8, 7.5_

- [x] 5. Implement email commands, Resend adapter, and signed webhook handling
  - [x] 5.1 Implement `EmailProvider` and `ReportEmailService`
    - Build one-recipient, one-attachment provider commands exclusively from persisted request/snapshot/attachment data; enforce subject/body contents and 200/2,000-character limits and use `report:{requestId}` as the sole logical idempotency key.
    - Persist one delivery row, submission/acceptance timestamps and 300-second deadline, map definitive provider errors to safe failures, and never report acceptance as sent.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.8, 6.9, 6.11, 6.12, 6.13, 7.6, 7.7_

  - [x]* 5.2 Write the property test for provider-command agreement
    - **Property 16: Email command agrees with persisted report**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment; parse the attachment independently and compare recipient, attachment, subject, body labels, limits, count, and totals.
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

  - [x] 5.3 Implement the pinned Resend provider adapter
    - Use `resend@6.0.2` to submit the singleton recipient and attachment with the stable idempotency key, capture provider message ID/acceptance time, and classify retryable versus definitive failures.
    - Verify webhook signatures from the unmodified payload with `svix-id`, `svix-timestamp`, and `svix-signature`; map delivered, failed, bounced, and suppressed events to typed provider events without exposing raw payloads or secrets.
    - _Requirements: 6.1, 6.2, 6.5, 6.6, 6.8, 6.9, 6.12, 7.6, 7.10_

  - [x] 5.4 Add durable provider-event processing and the raw-body webhook route
    - Mount `/api/webhooks/resend` before `express.json()`, reject invalid signatures with `401`, reject malformed recognized events with `400`, and return retryable `5xx` database failures.
    - Persist each verified event once by provider event ID, return `200` for duplicates, atomically apply delivery/rejection transitions by provider message ID, retain ignored/out-of-order/terminal events, and ensure only confirmed delivery reaches `SENT`.
    - _Requirements: 6.6, 6.8, 6.9, 6.11, 6.14, 7.7, 7.12_

  - [x]* 5.5 Write the property test for idempotent acceptance
    - **Property 17: Provider acceptance is idempotent**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment over positive duplicate counts, repeated message IDs, and nonterminal states.
    - **Validates: Requirements 6.5, 6.11**

  - [x]* 5.6 Write the property test for terminal-safe delivery transitions
    - **Property 18: Delivery state transitions are terminal-safe**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment; compare random duplicate/out-of-order event traces with an independent reference transition function.
    - **Validates: Requirements 6.6, 6.8, 6.9, 6.14**

  - [x]* 5.7 Add email-service, adapter, and webhook unit/integration tests
    - Use a fake adapter and signed fixtures to test limits, singleton fields, error mapping, raw-body verification, invalid/duplicate/out-of-order/delivered/rejected/late events, provider ID capture, and terminal no-ops.
    - _Requirements: 6.1–6.14, 7.6, 7.7, 7.10, 7.12_

  - [x]* 5.8 Add a reusable provider adapter contract suite
    - Run the contract against a local fake in CI and an environment-gated Resend sandbox in staging; verify attachment transfer, idempotency, acceptance capture, signature validation, and delivered/failure mapping without sending to real user addresses.
    - _Requirements: 6.1, 6.2, 6.5, 6.6, 6.8, 6.9, 6.11, 6.12_
- [x] 6. Implement durable outbox processing, restart recovery, and deadlines
  - [x] 6.1 Implement the PostgreSQL `ReportJob` repository and lease protocol
    - Add transactional enqueue, `FOR UPDATE SKIP LOCKED` claim, lease owner/expiry, bounded attempts, availability/backoff, safe last-error code, heartbeat, completion, and expired-lease reclaim operations.
    - Make request creation plus enqueue atomic and make terminal requests/jobs safe no-ops for one or many cooperative workers.
    - _Requirements: 1.6, 1.7, 3.11, 6.12, 6.13, 7.12_

  - [x] 6.2 Implement the restart-safe `ReportWorker` pipeline
    - Process durable stages in order: claim, exact snapshot, attachment generation/persistence, UTF-8 byte-size gate, delivery-row creation, provider submission, acceptance persistence, and job acknowledgement.
    - Resume from durable evidence: never re-query after snapshot, regenerate after attachment, change an idempotency key, resubmit after acceptance, or process a terminal request; classify permanent/transient failures and retry transient failures with bounded exponential backoff.
    - Persist progress/failure stage and make source entries/snapshots immutable across crashes and cleanup.
    - _Requirements: 3.8–3.13, 4.18, 6.5, 6.8, 6.9, 6.11, 6.12, 6.13, 7.4, 7.5, 7.6, 7.9, 7.11, 7.12_

  - [x]* 6.3 Write the property test for one logical email across retries
    - **Property 19: Submission retries represent one logical email**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment over crash points, lease expiry, network ambiguity, and retry schedules; assert one key, delivery row, and logical fake-provider message.
    - **Validates: Requirements 6.12**

  - [x] 6.4 Implement the delivery-deadline reaper
    - Sweep submitted/accepted requests with `deliveryDeadlineAt <= now`, atomically fail only nonterminal unconfirmed rows as `email_submission/delivery_timeout`, record audit/job completion, and keep later confirmations diagnostic.
    - Use the injected clock so the exact 300-second boundary is deterministic and safe across multiple workers.
    - _Requirements: 6.13, 6.14, 7.6, 7.7, 7.11, 7.12_

  - [x]* 6.5 Write the property test for the exact delivery deadline
    - **Property 20: Delivery deadline is exact**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment over arbitrary submit instants and times immediately before/at/after 300 seconds, confirmation states, and late events.
    - **Validates: Requirements 6.13, 6.14**

  - [x]* 6.6 Write the property test for the UTF-8 attachment size gate
    - **Property 24: Attachment size gate uses UTF-8 bytes**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment around `10,485,760` bytes, including multibyte characters; assert oversized reports fail at `report_size` with zero provider calls.
    - **Validates: Requirements 7.9**

  - [x]* 6.7 Add durable worker/outbox PostgreSQL integration tests
    - Test concurrent claims, lease expiry/reclaim, bounded attempts/backoff, process restart at every durable stage, snapshot/attachment reuse, provider timeout ambiguity, one idempotency key, acceptance no-resubmit, size rejection, stage failures, and 299.999/300-second deadline behavior.
    - _Requirements: 3.9, 3.11, 3.12, 6.5, 6.11, 6.12, 6.13, 6.14, 7.4, 7.5, 7.6, 7.9, 7.12_

- [x] 7. Add the typed frontend API and accessible responsive dashboard panel
  - [x] 7.1 Extend the frontend API client with report wire contracts
    - Add string-date report DTOs, `ReportApiError`, resolve/create/active/status/retry methods, stable UUID client request IDs for POSTs, non-retrying creates/retries, and retry-safe GET polling to `packages/frontend/src/services/api.ts`.
    - Map status/code/stage/message/field errors without string-matching and never expose or accept a recipient override.
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 2.5, 2.6, 2.7, 7.1–7.14_

  - [x] 7.2 Implement and integrate `BulkReportPanel`
    - Add the exact collapsed action label, exactly two native report-type radios, labeled date input, read-only account email text, last-valid inclusive period review, submit/progress/outcome states, and one retry control retaining failed selections.
    - On mount restore the active request; disable duplicate submits; poll every two seconds then five seconds after 30 seconds; stop on terminal/unmount; show success only for `SENT`; generate stage-specific safe failures and capped recipient/period outcome messages.
    - Use semantic names, keyboard-native controls, initial-expand-only focus movement, polite atomic status and alert live regions, `min-w-0`/wrapping/stacked responsive layout, and mobile 44×44 action areas; place the panel in normal flow in `DashboardPage.tsx` without obscuring existing totals, filters, entries, or New Entry.
    - _Requirements: 1.1–1.7, 2.5–2.7, 3.13, 6.7, 6.10, 7.4–7.14, 8.1–8.7_

  - [x]* 7.3 Write the property test for confirmed-success presentation
    - **Property 22: Sent success is equivalent to confirmed sent state**
    - Add exactly one frontend `fast-check` property with at least 100 runs and the required feature/property comment over all statuses/failure stages; assert success copy iff status is `SENT`.
    - **Validates: Requirements 7.7, 7.12**

  - [x]* 7.4 Add `BulkReportPanel` component and API-client tests
    - Use React Testing Library role/name queries and `user-event` keyboard flows to test labels, exactly two choices, immutable recipient, date errors with preserved prior period, duplicate-submit prevention, polling cleanup/backoff, active restoration, live announcements, stage copy, capped messages, one retry, retained selection, and no focus stealing.
    - Test stable versus new client IDs, typed error mapping, GET retry behavior, and that POSTs are not generically retried.
    - _Requirements: 1.1–1.7, 2.5–2.7, 3.13, 6.7, 6.10, 7.4–7.14, 8.1–8.4_

  - [x]* 7.5 Add Playwright accessibility and responsive browser tests
    - Create Playwright config/fixtures and dashboard tests at 320, 767, 768, common tablet/desktop widths, and 2560 CSS pixels; assert no horizontal viewport overflow, every report control is within bounds, and mobile action/submit/retry boxes are at least 44×44.
    - Verify keyboard-only operation, live announcements and automated axe scan; at desktop widths assert filters, totals, entries, and New Entry remain visible, unobscured, and clickable; add stable visual snapshots.
    - _Requirements: 8.1–8.7_

- [x] 8. Add safe observability, runtime configuration, and readiness
  - [x] 8.1 Implement report logging, metrics, correlation, and audit instrumentation
    - Add a JSON `ReportLogger` and in-process metric interfaces for the designed API, worker, snapshot, CSV, provider, webhook, deadline, retry, conflict, latency, and terminal events; pass request/report IDs and durations through every stage.
    - Include only allowlisted operational fields, hash or omit email, and exclude CSV content, restaurant names, tokens, keys, signatures, credentials, stack traces, and raw provider payloads.
    - Complete `AuditLog` instrumentation for create, retry, and terminal transitions without artifact bytes or secrets.
    - _Requirements: 7.10, 7.11, 7.12_

  - [x]* 8.2 Write the property test for secret-free public errors
    - **Property 25: Public unexpected errors are secret-free**
    - Add exactly one `fast-check` property with at least 100 runs and the required feature/property comment over arbitrary exceptions containing stack frames, session/provider credentials, signatures, and sentinel secrets; assert the fixed mapper output contains none.
    - **Validates: Requirements 7.10**

  - [x] 8.3 Add validated operational configuration and worker lifecycle code
    - Extend backend config and `.env.example` for `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `REPORT_FROM_EMAIL`, attachment limit `10485760`, lease/backoff/attempt settings, worker ID/poll interval, retention period, and public webhook URL without committing values.
    - Add a separate worker entrypoint and start command, graceful shutdown, periodic claim/deadline/retention sweeps, artifact-retention cleanup that preserves request/snapshot/audit metadata, and startup failure when required worker provider config is missing.
    - Extend readiness to check database/migration compatibility, provider configuration presence, and worker heartbeat without returning secret values; add metric-derived alert threshold configuration for stale leases, failure spikes, invalid signatures, and approaching deadlines.
    - _Requirements: 6.13, 7.9, 7.10, 7.11, 7.12_

  - [x]* 8.4 Add operational configuration, readiness, logging, and cleanup tests
    - Test missing/valid config, API versus worker readiness, heartbeat staleness, safe structured fields, email hashing, metric increments, alert thresholds, graceful worker shutdown, and retention cleanup boundaries with an injected clock.
    - _Requirements: 6.13, 7.9, 7.10, 7.11, 7.12_
- [x] 9. Complete integrated lifecycle and regression automation
  - [x]* 9.1 Add a full backend lifecycle integration suite
    - With migrated PostgreSQL, Supertest, fake clock, fake signed provider, and real worker repositories, drive authenticated create through snapshot/CSV/submission/acceptance/delivery and each failure/retry path; assert ownership, immutable artifacts, exact totals, one logical email, timeout safety, safe DTOs, and audit/metric events.
    - Include data retrieval, snapshot, CSV, report-size, provider rejection, unexpected error, duplicate/out-of-order webhook, late confirmation, and process-restart cases.
    - _Requirements: 1.6, 1.7, 2.5, 3.1–3.13, 4.1–4.18, 5.1–5.8, 6.1–6.14, 7.1–7.14_

  - [x]* 9.2 Add dashboard-level frontend integration tests
    - Render the existing `DashboardPage` with report API fixtures and exercise resolve, submit, refresh/active restoration, polling, confirmed success, all failure-stage retries, authentication recovery, and coexistence with filters, totals, entries, pagination, edit/delete, and New Entry.
    - Assert the report flow does not change dashboard query/filter state or the existing synchronous export behavior.
    - _Requirements: 1.1–1.7, 2.5–2.7, 3.13, 6.7, 6.10, 7.1, 7.4–7.14, 8.1–8.7_

  - [x] 9.3 Add CI automation for database, property, browser, and build gates
    - Add/update workflow code to provision PostgreSQL, apply migrations, generate Prisma, run backend/frontend targeted and full `vitest run` suites, run all 25 property tests, install pinned Playwright Chromium, run browser tests, lint, and build without watch commands.
    - Cache only reproducible npm/Playwright artifacts and upload failure traces/screenshots without environment secrets or report CSV contents.
    - _Requirements: 3.11, 3.12, 5.1–5.5, 6.11–6.14, 7.10, 8.1–8.7_

  - [x]* 9.4 Add explicit existing-feature regression tests where coverage is missing
    - Preserve and extend automated checks for authentication, delivery-entry create/edit/delete, analytics/totals, filters, pagination, autocomplete, current CSV download, dashboard loading, and report-route isolation.
    - _Requirements: 1.1, 3.4, 3.5, 3.6, 3.7, 8.7_

- [-] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - Run Prisma format/validate/generate, migration apply and rollback verification, targeted report suites, full workspace `vitest run`, Playwright browser tests, workspace lint, TypeScript/backend/frontend builds, and production dependency/config checks.
  - Confirm every correctness property has exactly one passing `fast-check` property with at least 100 runs and every requirement acceptance criterion is covered by an implementation task and automated test.

## Notes

- Tasks marked with `*` are optional automated-test tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Property tasks map one-to-one to all 25 correctness properties in `design.md`; each must retain the exact `Feature: bulk-csv-report-email, Property N: ...` comment.
- TypeScript is the implementation language already established by the design and both existing workspaces.
- All new dependencies are exact and Node 18-compatible; do not replace them with caret/tilde ranges when updating manifests or the lockfile.
- Database-backed invariants must use migrated PostgreSQL rather than Prisma mocks. Provider tests must use fakes/sandbox recipients and must not email real users.
- The API and worker are separate processes; no report lifecycle may depend on an in-memory queue or development-server/watch command.
- `requirements.md` and `design.md` are validated inputs and must not be modified while executing this plan.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4"] },
    { "id": 2, "tasks": ["2.1", "3.1", "4.1", "6.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "2.5", "3.2", "3.3", "3.4", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7", "4.8", "4.9", "4.10", "4.11"] },
    { "id": 4, "tasks": ["2.6", "2.7", "2.8", "2.9", "5.1"] },
    { "id": 5, "tasks": ["2.10", "5.2", "5.3", "6.2", "7.1", "8.2"] },
    { "id": 6, "tasks": ["5.4", "5.7", "6.3", "6.4", "6.6", "7.2"] },
    { "id": 7, "tasks": ["5.5", "5.6", "5.8", "6.5", "6.7", "7.3", "7.4", "7.5"] },
    { "id": 8, "tasks": ["8.1", "9.2"] },
    { "id": 9, "tasks": ["8.3"] },
    { "id": 10, "tasks": ["8.4", "9.1", "9.4"] },
    { "id": 11, "tasks": ["9.3"] }
  ]
}
```
