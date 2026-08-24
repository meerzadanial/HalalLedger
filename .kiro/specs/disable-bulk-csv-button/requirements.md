# Requirements Document

## Introduction

This feature keeps the existing **Bulk Print / Email CSV** dashboard action visible but unavailable in production builds. The production action becomes a native disabled, grey button that cannot expand or expose the existing bulk report panel. Development and test builds retain the current enabled behavior. The change is limited to frontend presentation and interaction.

## Glossary

- **Bulk_Report_Panel**: The existing frontend component that renders the bulk CSV action and its expandable report controls.
- **Bulk_Report_Action**: The existing button labeled `Bulk Print / Email CSV`.
- **Production_Build**: A frontend bundle for which Vite exposes `import.meta.env.PROD` as `true`.
- **Non_Production_Build**: A development or test frontend execution for which Vite exposes `import.meta.env.PROD` as `false`.
- **Dashboard**: The existing authenticated page containing income totals, filters, delivery entries, the Bulk_Report_Action, and other dashboard actions.

## Requirements

### Requirement 1: Disable the Production Action

**User Story:** As an operator, I want the bulk CSV action unavailable in production, so that production users cannot access the bulk report panel.

#### Acceptance Criteria

1. WHILE the Dashboard runs from a Production_Build, THE Bulk_Report_Panel SHALL display the Bulk_Report_Action with the label `Bulk Print / Email CSV`
2. WHILE the Dashboard runs from a Production_Build, THE Bulk_Report_Panel SHALL render the Bulk_Report_Action as a native HTML button with the `disabled` state
3. WHILE the Dashboard runs from a Production_Build, THE Bulk_Report_Panel SHALL style the Bulk_Report_Action with grey foreground, background, and border presentation that is visually distinct from the enabled indigo presentation
4. WHILE the Dashboard runs from a Production_Build, WHEN a user attempts to activate the Bulk_Report_Action, THE Bulk_Report_Panel SHALL keep the bulk report controls unrendered
5. WHILE the Dashboard runs from a Production_Build, THE Bulk_Report_Panel SHALL omit hover and pointer styling that communicates an enabled action

### Requirement 2: Preserve Non-Production Behavior

**User Story:** As a developer, I want existing development and test behavior preserved, so that I can continue developing and testing the complete bulk report workflow.

#### Acceptance Criteria

1. WHILE the Dashboard runs from a Non_Production_Build, THE Bulk_Report_Panel SHALL render the Bulk_Report_Action in its existing enabled state and indigo presentation
2. WHILE the Dashboard runs from a Non_Production_Build, WHEN a user activates the Bulk_Report_Action, THE Bulk_Report_Panel SHALL execute the existing panel expansion behavior
3. WHILE the Dashboard runs from a Non_Production_Build, THE Bulk_Report_Panel SHALL preserve the existing bulk report controls, API interactions, request states, and outcome presentation

### Requirement 3: Contain the Change

**User Story:** As a maintainer, I want the production restriction isolated to the frontend action, so that unrelated services and dashboard features remain unchanged.

#### Acceptance Criteria

1. THE Bulk_Report_Panel SHALL determine the Production_Build state within the frontend component by using the existing Vite environment contract
2. WHILE the Bulk_Report_Action is disabled, THE Bulk_Report_Panel SHALL make no bulk report API request in response to attempted activation
3. THE Dashboard SHALL preserve the existing behavior of income totals, filters, delivery entries, authentication, and actions other than the Bulk_Report_Action
4. THE feature SHALL require no change to backend APIs, Render configuration, Resend integration, secrets, or the existing `.kiro/specs/bulk-csv-report-email/` specification
