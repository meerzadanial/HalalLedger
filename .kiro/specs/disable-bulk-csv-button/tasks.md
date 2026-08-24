# Implementation Plan: Disable Bulk CSV Button

## Overview

Apply a minimal TypeScript change inside the existing `BulkReportPanel`: use Vite's production flag to render the current action as a grey native disabled button and prevent panel rendering in production, while preserving the complete development/test workflow. Add focused component coverage, then run existing frontend regression and build checks. Do not modify backend, deployment, provider, secret, or existing-spec files.

## Tasks

- [ ] 1. Add the production-only frontend gate
  - [ ] 1.1 Update `BulkReportPanel` production rendering
    - Read `import.meta.env.PROD` inside `packages/frontend/src/components/BulkReportPanel.tsx` without adding a dashboard prop or changing component/API interfaces.
    - Keep the exact `Bulk Print / Email CSV` label and native button element; set `disabled` and collapsed accessibility state in production.
    - Select explicit grey text, background, and border utilities in production while excluding enabled indigo, hover, and pointer affordances.
    - Guard report-panel rendering in production and preserve the existing enabled classes, toggle flow, report controls, API behavior, polling, and outcomes when the production flag is false.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 3.1, 3.2_

  - [ ]* 1.2 Add focused production and non-production component tests
    - Extend `packages/frontend/src/components/BulkReportPanel.test.tsx` using isolated Vite environment stubbing and module reset/cleanup where needed.
    - Assert that production keeps the exact action visible, natively disabled, collapsed, grey, and free of enabled hover/indigo classes.
    - Attempt pointer and keyboard activation in production; assert the panel controls remain absent and supplied report API mocks receive no activation-triggered calls.
    - Retain or strengthen the existing default test-mode assertion that the enabled action expands the unchanged report panel.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 3.2_

- [ ] 2. Validate frontend integration and change isolation
  - [ ]* 2.1 Run focused and dashboard regression tests
    - Run the non-watch `BulkReportPanel`, `DashboardPage`, API-client, and frontend integration Vitest suites.
    - If an assertion must change, limit the edit to environment-specific button expectations and preserve all development/test report workflow and unrelated dashboard assertions.
    - _Requirements: 2.1, 2.2, 2.3, 3.3_

  - [ ]* 2.2 Run frontend static and production-build checks
    - Run the frontend lint and TypeScript/Vite production build commands.
    - Confirm the production environment branch compiles without adding dependencies or changing backend APIs, Render, Resend, secrets, or `.kiro/specs/bulk-csv-report-email/`.
    - _Requirements: 3.1, 3.3, 3.4_

- [ ] 3. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional automated-test tasks and can be skipped for a faster implementation.
- No property-based tests are planned because the meaningful state space contains only production and non-production render configurations.
- TypeScript is the detected implementation language and the language used by the existing frontend.
- The implementation scope is `packages/frontend/src/components/BulkReportPanel.tsx` plus focused frontend tests only.
- Do not implement backend, Render, Resend, secret, deployment, or existing `bulk-csv-report-email` spec changes.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2"] }
  ]
}
```
