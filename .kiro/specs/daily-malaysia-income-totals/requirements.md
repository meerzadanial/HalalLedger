# Requirements Document

## Introduction

The Daily Malaysia Income Totals feature makes the four dashboard total cards represent the applicable Malaysian calendar date while preserving the historical delivery-entry list and all stored records. The feature aligns totals and list filtering when users select explicit dates, adds payment filtering to totals, refreshes default totals when the Malaysian date changes, and preserves user isolation and pagination.

## Glossary

- **Daily_Income_Dashboard**: The authenticated dashboard that displays delivery entries, filters, pagination controls, and the Four_Total_Cards.
- **Totals_Aggregator**: The backend component that calculates the Four_Total_Cards from matching Delivery_Entry records.
- **Entry_List**: The paginated dashboard collection of Delivery_Entry records.
- **Delivery_Record_Store**: The persistent store containing Delivery_Entry records.
- **Delivery_Entry**: A user-owned delivery record with Entry_Date, Created_At, Restaurant_Status, Fare_Amount, Has_Cash_Order, and optional Cash_Amount fields.
- **Authenticated_User**: The user identity established by the authenticated request.
- **Entry_Date**: The user-selected or default delivery date used to assign a Delivery_Entry to a calendar day, including manually backdated dates.
- **Created_At**: The timestamp recording when a Delivery_Entry was persisted.
- **Malaysia_Calendar_Day**: A local calendar date in the `Asia/Kuala_Lumpur` time zone, spanning local 00:00 inclusive to the next local 00:00 exclusive.
- **Current_Malaysia_Day**: The Malaysia_Calendar_Day containing the instant when totals are evaluated.
- **Explicit_Date_Filter**: A user-selected single Malaysia_Calendar_Day or inclusive range of Malaysia_Calendar_Day values.
- **Date_Filter**: The component that determines Delivery_Entry membership in a Malaysia_Calendar_Day or Explicit_Date_Filter.
- **Dashboard_Filter**: The component that combines date, Restaurant_Status_Filter, and Payment_Filter selections.
- **Restaurant_Status**: The `halal` or `non-halal` classification stored on a Delivery_Entry.
- **Restaurant_Status_Filter**: An optional selection restricting results to one Restaurant_Status.
- **Payment_Filter**: An optional `Cash_Only` or `Digital_Only` selection restricting results by Has_Cash_Order.
- **Cash_Only**: The Payment_Filter value selecting Delivery_Entry records whose Has_Cash_Order value is true.
- **Digital_Only**: The Payment_Filter value selecting Delivery_Entry records whose Has_Cash_Order value is false.
- **Fare_Amount**: The digital fare component of a Delivery_Entry.
- **Cash_Amount**: The cash component of a Delivery_Entry, treated as zero when absent.
- **Entry_Income**: The sum of Fare_Amount and Cash_Amount for one Delivery_Entry.
- **Four_Total_Cards**: Total halal income, total non-halal income, total cash income, and total digital income.
- **Matching_Set**: The Authenticated_User's Delivery_Entry records satisfying all filters applicable to a request.
- **Pagination**: The limit-and-offset slicing of the filtered Entry_List together with the full matching record count.
- **Dashboard_Read_Operation**: A totals request, entry-list request, filter application, pagination request, or automatic midnight refresh that reads Delivery_Entry records.

## Requirements

### Requirement 1: Malaysian Daily Date Semantics

**User Story:** As a delivery driver, I want totals assigned by delivery date in Malaysia, so that backdated and current-day income appears on the intended day.

#### Acceptance Criteria

1. THE Date_Filter SHALL assign each Delivery_Entry to exactly one Malaysia_Calendar_Day equal to Entry_Date, with the assignment unchanged when only Created_At changes.
2. WHEN Entry_Date represents a Malaysia_Calendar_Day earlier than the Malaysia_Calendar_Day containing Created_At, THE Date_Filter SHALL assign the Delivery_Entry to the Malaysia_Calendar_Day represented by Entry_Date.
3. WHEN totals are requested without an Explicit_Date_Filter, THE Totals_Aggregator SHALL include exactly the Delivery_Entry records owned by the Authenticated_User, assigned to the Current_Malaysia_Day evaluated at the request instant, and satisfying every active non-date filter.
4. THE Date_Filter SHALL represent each Malaysia_Calendar_Day as the interval from local 00:00 inclusive to the next local 00:00 exclusive in `Asia/Kuala_Lumpur`.

### Requirement 2: Explicit Date Filtering

**User Story:** As a delivery driver, I want selected dates to control both totals and entries, so that the dashboard presents one consistent historical period.

#### Acceptance Criteria

1. WHEN an Authenticated_User selects one Malaysia_Calendar_Day, THE Dashboard_Filter SHALL produce identical pre-Pagination Matching_Set values for the Totals_Aggregator and the Entry_List containing exactly the Delivery_Entry records for the selected Malaysia_Calendar_Day that satisfy every active filter.
2. WHEN an Authenticated_User selects an Explicit_Date_Filter with a start Malaysia_Calendar_Day on or before the end Malaysia_Calendar_Day, THE Dashboard_Filter SHALL produce Totals_Aggregator and pre-Pagination Entry_List Matching_Set values containing exactly the Delivery_Entry records on both boundary dates and every intervening date that satisfy every active filter.
3. IF an active Explicit_Date_Filter has a start Malaysia_Calendar_Day after the end Malaysia_Calendar_Day, THEN THE Daily_Income_Dashboard SHALL remove the active Explicit_Date_Filter, display a date-range validation error in place of the Four_Total_Cards and Entry_List, and expose no Delivery_Entry records.
4. WHERE a Restaurant_Status_Filter and an Explicit_Date_Filter are active, THE Dashboard_Filter SHALL restrict both the Totals_Aggregator and the pre-Pagination Entry_List to Delivery_Entry records satisfying the Explicit_Date_Filter, the Restaurant_Status_Filter, and every other active filter.
5. WHERE a Payment_Filter and an Explicit_Date_Filter are active, THE Dashboard_Filter SHALL restrict both the Totals_Aggregator and the pre-Pagination Entry_List to Delivery_Entry records satisfying the Explicit_Date_Filter, the Payment_Filter, and every other active filter.
6. IF any condition prevents the Dashboard_Filter from applying every active filter fully and identically to the Totals_Aggregator and the Entry_List, THEN THE Daily_Income_Dashboard SHALL display a filter-application error in place of the Four_Total_Cards and Entry_List and expose no partial or unfiltered totals or Delivery_Entry records.
7. WHEN a valid Explicit_Date_Filter and all other active filters produce an empty Matching_Set, THE Daily_Income_Dashboard SHALL display zero for each Four_Total_Cards value and an empty Entry_List.
8. WHEN an Authenticated_User corrects an invalid Explicit_Date_Filter so the start Malaysia_Calendar_Day is on or before the end Malaysia_Calendar_Day, THE Dashboard_Filter SHALL automatically apply the corrected Explicit_Date_Filter.

### Requirement 3: Default Totals and Historical Entry List

**User Story:** As a delivery driver, I want today's totals without losing access to prior entries, so that the dashboard emphasizes daily income while retaining history.

#### Acceptance Criteria

1. WHEN the Daily_Income_Dashboard loads without an Explicit_Date_Filter, THE Entry_List SHALL use all historical Delivery_Entry records owned by the Authenticated_User and matching every active non-date filter as the pre-Pagination Matching_Set.
2. WHEN the Daily_Income_Dashboard loads without an Explicit_Date_Filter, THE Totals_Aggregator SHALL use exactly the Current_Malaysia_Day Delivery_Entry records owned by the Authenticated_User and matching every active non-date filter.
3. WHERE a Restaurant_Status_Filter is active without an Explicit_Date_Filter, THE Dashboard_Filter SHALL apply the Restaurant_Status_Filter and every other active non-date filter to both the historical Entry_List Matching_Set and the Current_Malaysia_Day Totals_Aggregator Matching_Set.
4. WHERE Cash_Only is active without an Explicit_Date_Filter, THE Dashboard_Filter SHALL restrict both the historical Entry_List Matching_Set and the Current_Malaysia_Day Totals_Aggregator Matching_Set to Delivery_Entry records whose Has_Cash_Order value is true after applying every other active non-date filter.
5. WHERE Digital_Only is active without an Explicit_Date_Filter, THE Dashboard_Filter SHALL restrict both the historical Entry_List Matching_Set and the Current_Malaysia_Day Totals_Aggregator Matching_Set to Delivery_Entry records whose Has_Cash_Order value is false after applying every other active non-date filter.
6. WHEN an Authenticated_User clears an Explicit_Date_Filter, THE Daily_Income_Dashboard SHALL restore Four_Total_Cards values for the Current_Malaysia_Day and the historical Entry_List scope while retaining every active non-date filter.
7. WHEN an Authenticated_User clears an Explicit_Date_Filter, THE Daily_Income_Dashboard SHALL use offset zero for the next Entry_List request.
8. IF either the Totals_Aggregator result or the Entry_List result fails after all requested data-loading operations have completed, THEN THE Daily_Income_Dashboard SHALL display one data-load error in place of both the Four_Total_Cards and Entry_List while retaining the active filters, Pagination state, and Delivery_Record_Store state.
9. WHEN an Authenticated_User navigates Pagination without selecting, changing, or clearing a filter, THE Daily_Income_Dashboard SHALL use the requested Pagination offset for the next Entry_List request.

### Requirement 4: Payment Filtering and Aggregation

**User Story:** As a delivery driver, I want payment filters applied consistently to entries and totals, so that each total card reflects the selected payment population.

#### Acceptance Criteria

1. WHERE Cash_Only is active, THE Payment_Filter SHALL select exactly the Delivery_Entry records whose Has_Cash_Order value is true after every other active filter is applied.
2. WHERE Digital_Only is active, THE Payment_Filter SHALL select exactly the Delivery_Entry records whose Has_Cash_Order value is false after every other active filter is applied.
3. WHERE a Payment_Filter is active, THE Totals_Aggregator SHALL calculate all Four_Total_Cards values from the payment-filtered Matching_Set.
4. THE Totals_Aggregator SHALL calculate total halal income as exactly the sum of Entry_Income for Matching_Set records whose Restaurant_Status is `halal`.
5. THE Totals_Aggregator SHALL calculate total non-halal income as exactly the sum of Entry_Income for Matching_Set records whose Restaurant_Status is `non-halal`.
6. THE Totals_Aggregator SHALL calculate total cash income as exactly the sum of Cash_Amount for every record in the Matching_Set.
7. THE Totals_Aggregator SHALL calculate total digital income as exactly the sum of Fare_Amount for every record in the Matching_Set.
8. WHERE Cash_Only is active, THE Totals_Aggregator SHALL contribute Fare_Amount plus Cash_Amount from each Matching_Set record to the applicable halal or non-halal total.
9. WHEN the Matching_Set is empty, THE Totals_Aggregator SHALL return zero for each Four_Total_Cards value as the final aggregation result.

### Requirement 5: Malaysian Midnight Refresh

**User Story:** As a delivery driver, I want an open dashboard to move to the new Malaysian day automatically, so that daily totals remain current without a manual reload.

#### Acceptance Criteria

1. WHILE the Daily_Income_Dashboard is open without an Explicit_Date_Filter, WHEN the Current_Malaysia_Day changes, THE Daily_Income_Dashboard SHALL display refreshed Four_Total_Cards values for the new Current_Malaysia_Day within 60 seconds using every active non-date filter.
2. WHILE the Daily_Income_Dashboard is open with an Explicit_Date_Filter, WHEN the Current_Malaysia_Day changes, THE Daily_Income_Dashboard SHALL retain the unchanged Explicit_Date_Filter as the Four_Total_Cards date scope.
3. WHILE the Daily_Income_Dashboard is open without an Explicit_Date_Filter, WHEN the Current_Malaysia_Day changes, THE Entry_List SHALL retain the historical date scope and every active non-date filter until the Authenticated_User manually changes the Entry_List date scope.
4. IF an automatic Malaysian midnight refresh fails, THEN THE Daily_Income_Dashboard SHALL perform no more than three retries at 30-second intervals and cease retrying after the first successful refresh.
5. IF the automatic Malaysian midnight refresh and all three retries fail, THEN THE Daily_Income_Dashboard SHALL display a refresh error within 1 second after the final failed retry.
6. IF the automatic Malaysian midnight refresh and all three retries fail, THEN THE Daily_Income_Dashboard SHALL continue displaying the complete Four_Total_Cards values from the last successful load.
7. IF an automatic Malaysian midnight refresh remains incomplete 60 seconds after the Current_Malaysia_Day changes because of a network delay, THEN THE Daily_Income_Dashboard SHALL continue the in-progress refresh until the refresh succeeds or fails.

### Requirement 6: Data Preservation, User Isolation, and Pagination

**User Story:** As a delivery driver, I want daily calculations to preserve records and existing access behavior, so that the feature cannot remove history or expose another user's data.

#### Acceptance Criteria

1. WHEN the Daily Malaysia Income Totals feature is deployed, THE Delivery_Record_Store SHALL preserve the count, identifiers, and field values of all existing Delivery_Entry records.
2. WHEN a Dashboard_Read_Operation succeeds or fails, THE Delivery_Record_Store SHALL retain the same Delivery_Entry count, identifiers, and field values present before the Dashboard_Read_Operation.
3. WHEN the Current_Malaysia_Day changes, THE Delivery_Record_Store SHALL retain every Delivery_Entry record from each prior Malaysia_Calendar_Day.
4. WHEN an Authenticated_User requests totals, THE Totals_Aggregator SHALL exclude Delivery_Entry records owned by other users before applying totals filters and calculating the Four_Total_Cards.
5. WHEN an Authenticated_User requests entries, THE Entry_List SHALL exclude Delivery_Entry records owned by other users before applying Entry_List filters, calculating the full matching count, ordering records, and applying Pagination.
6. WHEN an Authenticated_User requests Pagination with a limit from 1 through 100 and an offset from 0 through 2147483647, THE Entry_List SHALL accept the Pagination values.
7. WHEN valid Pagination is applied, THE Entry_List SHALL return the exact ordered slice beginning after the requested offset and containing up to the requested limit from the filtered pre-Pagination Matching_Set.
8. THE Entry_List SHALL report the full count of records in the filtered pre-Pagination Matching_Set before limit-and-offset slicing.
9. WHEN valid Pagination is applied, THE Entry_List SHALL preserve the pre-Pagination ordering and return exactly the lesser of the requested limit and the number of matching records remaining after the requested offset.
10. WHEN an Authenticated_User selects, changes, or clears any filter, THE Daily_Income_Dashboard SHALL use offset zero for the next Entry_List request.
11. IF a Pagination limit is outside 1 through 100 or a Pagination offset is outside 0 through 2147483647, THEN THE Daily_Income_Dashboard SHALL display a Pagination validation error, expose no Delivery_Entry records, and retain the Delivery_Record_Store state and active filter state unchanged.

## Correctness Properties

The following properties define reference-model behavior suitable for property-based testing. Generated monetary values use exact two-decimal arithmetic, generated dates include Malaysian-day boundaries, and generated data sets include multiple users, restaurant statuses, and payment states.

### Property 1: Entry Date Dominance

*For any* Delivery_Entry set in which Entry_Date and Created_At vary independently, each Delivery_Entry SHALL belong to exactly one Malaysia_Calendar_Day equal to Entry_Date, and Date_Filter membership SHALL remain unchanged when only Created_At values change, including when Entry_Date predates the Malaysia_Calendar_Day containing Created_At.

**Validates: Requirements 1.1, 1.2**

### Property 2: Default Malaysian-Day Totals

*For any* request instant and Delivery_Entry set, totals without an Explicit_Date_Filter SHALL equal reference totals over entries owned by the Authenticated_User whose Entry_Date belongs to the Current_Malaysia_Day at that request instant in `Asia/Kuala_Lumpur` and that satisfy every active non-date filter; local 00:00 SHALL be included and the next local 00:00 SHALL be excluded.

**Validates: Requirements 1.3, 1.4**

### Property 3: Inclusive Explicit Date Selection

*For any* valid single date or ordered date range and any combination of active filters, the totals Matching_Set and pre-Pagination Entry_List Matching_Set SHALL be identical and contain exactly the entries satisfying every active filter whose Entry_Date local date equals the single date or lies inclusively between the range boundaries; correcting an invalid range into a valid range SHALL automatically apply the corrected range.

**Validates: Requirements 2.1, 2.2, 2.8**

### Property 4: Conjunctive Filter Composition

*For any* combination of Explicit_Date_Filter, Restaurant_Status_Filter, Payment_Filter, and Delivery_Entry records, each Matching_Set SHALL equal the records satisfying every filter applicable to that request scope, with Cash_Only selecting Has_Cash_Order equal to true and Digital_Only selecting Has_Cash_Order equal to false.

**Validates: Requirements 2.4, 2.5, 3.3, 3.4, 3.5**

### Property 5: Default Scope Separation

*For any* historical Delivery_Entry set without an Explicit_Date_Filter, the pre-Pagination Entry_List SHALL equal all owned historical records matching active non-date filters, while the totals Matching_Set SHALL equal only owned Current_Malaysia_Day records matching the same non-date filters; clearing an Explicit_Date_Filter SHALL restore both scopes and use offset zero.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

### Property 6: Payment Selection Semantics

*For any* Delivery_Entry set and any other active filters, Cash_Only SHALL select exactly otherwise-matching records with Has_Cash_Order equal to true, and Digital_Only SHALL select exactly otherwise-matching records with Has_Cash_Order equal to false.

**Validates: Requirements 4.1, 4.2**

### Property 7: Four-Card Aggregation Accuracy

*For any* payment-filtered Matching_Set, total halal income SHALL equal the exact sum of Fare_Amount plus Cash_Amount over halal records, total non-halal income SHALL equal the same exact sum over non-halal records, total cash income SHALL equal the exact Cash_Amount sum, and total digital income SHALL equal the exact Fare_Amount sum; an empty Matching_Set SHALL produce four zero values as the final aggregation result.

**Validates: Requirements 2.7, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9**

### Property 8: Midnight Scope Transition and Retry

*For any* simulated transition between consecutive Malaysia_Calendar_Day values, an open dashboard without an Explicit_Date_Filter SHALL display refreshed totals for the new day within 60 seconds using active non-date filters and preserve the historical Entry_List scope until a manual date-scope change; an open dashboard with an Explicit_Date_Filter SHALL preserve the selected date scope. A failed automatic refresh SHALL produce at most three retries at 30-second intervals, cease on success, and, after three failed retries, preserve the last complete successful totals and display a refresh error within 1 second. An in-progress refresh delayed beyond 60 seconds by the network SHALL continue until success or failure.

**Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7**

### Property 9: Storage Invariance Under Deployment and Dashboard Reads

*For any* Delivery_Record_Store state, feature deployment, Malaysia_Calendar_Day transition, and sequence of successful or failed Dashboard_Read_Operation values, the count and multiset of persisted Delivery_Entry identifiers and field values after the sequence SHALL equal the count and multiset before the sequence.

**Validates: Requirements 6.1, 6.2, 6.3**

### Property 10: User Isolation

*For any* two distinct Authenticated_User identities and any mixed-owner Delivery_Entry set, each user's totals and Entry_List SHALL equal the corresponding reference result after removing every record owned by the other user before filtering, counting, ordering, or Pagination.

**Validates: Requirements 6.4, 6.5**

### Property 11: Pagination Consistency

*For any* filtered pre-Pagination Entry_List, limit from 1 through 100, and offset from 0 through 2147483647, the returned page SHALL equal the corresponding ordered limit-and-offset slice, the page length SHALL equal the lesser of the limit and the number of records remaining after the offset, and the reported total SHALL equal the filtered list length before slicing. For any limit or offset outside the valid ranges, the dashboard SHALL expose no entries and preserve stored data and active filters.

**Validates: Requirements 6.6, 6.7, 6.8, 6.9, 6.11**

### Property 12: Filter-Change Pagination Reset

*For any* Pagination offset, the first Entry_List request after a filter selection, change, or clear action SHALL use offset zero, while Pagination navigation without a filter action SHALL use the requested offset.

**Validates: Requirements 3.9, 6.10**

### Property 13: Invalid or Partially Applied Date Filter Fails Closed

*For any* Explicit_Date_Filter whose start date follows the end date, the Dashboard_Filter SHALL remove the active range and the Daily_Income_Dashboard SHALL display a validation error in place of totals and entries while exposing no records; for any condition that prevents complete and identical application of every active filter to totals and entries, the Daily_Income_Dashboard SHALL expose neither partial nor unfiltered totals or entries.

**Validates: Requirements 2.3, 2.6**