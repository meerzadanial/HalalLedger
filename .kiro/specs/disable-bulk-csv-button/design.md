# Technical Design: Disable Bulk CSV Button

## Overview

Make a localized frontend change in `packages/frontend/src/components/BulkReportPanel.tsx`. The component reads Vite's static `import.meta.env.PROD` flag, keeps the existing **Bulk Print / Email CSV** button in the dashboard, and renders that button as natively disabled with grey styling in production bundles. Development and Vitest executions continue through the existing enabled path.

The implementation does not remove the `BulkReportPanel`, alter its API contracts, or change the completed `.kiro/specs/bulk-csv-report-email/` feature. No backend, Render, Resend, secret, routing, persistence, or unrelated dashboard file requires a functional change.

## Architecture

The existing component boundary remains unchanged:

```text
DashboardPage
  └─ BulkReportPanel
       ├─ import.meta.env.PROD ── production presentation gate
       ├─ Bulk Print / Email CSV button
       └─ existing expandable panel and report workflow
```

`BulkReportPanel` owns the production decision, as selected during clarification. `DashboardPage` does not pass a new environment prop and remains unaware of deployment mode.

## Components and Interfaces

No public interface changes are required:

- `BulkReportPanelProps` remains unchanged.
- `BulkReportApi` remains unchanged.
- Frontend `reportsApi` contracts remain unchanged.
- Backend routes, provider contracts, and deployment configuration remain unchanged.

### Production mode

Inside `BulkReportPanel`, derive one immutable render-time flag:

```ts
const productionDisabled = import.meta.env.PROD;
```

Apply the flag to the existing action button:

- keep `type="button"` and the exact visible label;
- set the native `disabled` attribute when `productionDisabled` is `true`;
- report `aria-expanded={false}` while disabled;
- select grey foreground, background, and border classes instead of enabled indigo, hover, and pointer affordances;
- guard panel rendering with `expanded && !productionDisabled` so the report controls cannot be exposed in production even if component state is initialized unexpectedly.

The existing `onClick` handler may remain attached because a native disabled button does not dispatch user activation. The explicit render guard provides a second presentation-level invariant without modifying report APIs or workflow state.

### Development and test mode

When `import.meta.env.PROD` is `false`, preserve the current button attributes, classes, toggle handler, expansion state, controls, API calls, polling, messages, and adjacent action rendering. No production restriction is passed into report services.

### Styling

Use existing Tailwind utilities already compiled by the frontend. The enabled class string remains the current indigo/white/hover/focus presentation. The production branch uses explicit grey text, background, and border utilities plus a disabled cursor treatment; it excludes enabled hover styling. No stylesheet, theme, or dependency is added.

## Data Models

There are no data-model changes. Frontend report DTOs, backend database models, and persisted report data remain unchanged.

## Error Handling

The production restriction introduces no new asynchronous operation or error state. Native button disabling prevents user activation, and the render guard prevents panel exposure. Existing report validation, request, polling, and outcome error handling remains active only through the unchanged non-production interaction path.

## Correctness Properties

No property-based correctness properties are defined for this feature. The acceptance criteria describe a binary build configuration and deterministic DOM presentation rather than pure logic with a large input space. One production render and one non-production render cover the meaningful state space; randomized execution would not provide additional defect-finding value.

The testing prework classified the criteria as example, integration, or smoke checks. Production visibility, native disabling, grey classes, blocked expansion, and zero activation-triggered API calls form one focused production component scenario. Existing enabled appearance and expansion form one non-production regression scenario. Broader workflow and dashboard preservation are covered by established integration suites. No redundant property-based tests are introduced.

## Testing Strategy

### Focused component tests

Extend `packages/frontend/src/components/BulkReportPanel.test.tsx` with controlled production-mode coverage using Vitest's Vite environment stubbing and module reset/import where required:

1. In production mode, assert the exact action remains visible, is a native disabled button, exposes `aria-expanded="false"`, uses grey classes, and excludes enabled indigo/hover classes.
2. Attempt pointer and keyboard activation in production mode; assert the report region and report controls remain absent and supplied bulk report API mocks receive no activation-related calls.
3. In the default test environment, retain existing assertions that the action is enabled and expands the complete panel.

Restore stubbed environment values and modules after each production-mode test so existing tests remain isolated.

### Regression and build checks

Run non-watch commands only:

```sh
npm run test --workspace @halalornot/frontend -- --run
npm run build --workspace @halalornot/frontend
npm run lint --workspace @halalornot/frontend
```

The existing `BulkReportPanel`, `DashboardPage`, API-client, and integration tests verify that development/test behavior and unrelated dashboard functionality remain unchanged. A successful Vite production build verifies the static environment branch compiles.

## Requirements Traceability

| Requirement | Design coverage | Verification |
|---|---|---|
| 1.1–1.5 | Production button attributes, render guard, grey conditional classes | Focused production component test |
| 2.1–2.3 | Unchanged non-production branch and existing report workflow | Existing component/integration suites |
| 3.1–3.2 | Internal `import.meta.env.PROD` gate and native disabled semantics | Production environment test and build |
| 3.3–3.4 | No interface, service, deployment, or unrelated dashboard changes | Frontend regression suites and scoped diff review |
