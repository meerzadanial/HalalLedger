# Requirements Document

## Introduction

The bulk CSV report email feature extends the delivery-income dashboard with a bulk report/export action. An authenticated delivery driver can select a weekly or monthly calendar period, generate a CSV report containing every owned delivery entry in that period, and send the CSV report to the email address associated with the authenticated account. The feature retains the user's “bulk print” terminology in the control label while treating the action as CSV report generation and email delivery rather than physical printing.

## Glossary

- **Bulk_Report_Feature**: The complete capability for selecting a report period, collecting delivery data, generating a CSV report, and sending the CSV report by email.
- **Bulk_Report_Interface**: The dashboard user interface that collects report selections and presents report progress and outcomes.
- **Report_Period_Resolver**: The component that converts a report type and reference date into an inclusive start date and end date.
- **Report_Data_Service**: The component that retrieves the delivery entries and income totals for a report.
- **CSV_Report_Generator**: The component that converts a report snapshot into CSV content.
- **Report_Email_Service**: The component that submits a generated CSV report to the configured email provider.
- **Dashboard**: The authenticated web page that displays income totals, delivery entries, filters, and delivery-entry actions.
- **Authenticated_User**: A delivery driver with a valid application session.
- **Account_Email**: The unique email address stored for the Authenticated_User and used as the report recipient.
- **Delivery_Entry**: A user-owned income record containing restaurant name, restaurant status, fare amount, `has_cash_order`, optional cash amount, entry date, and timestamps.
- **has_cash_order**: The Boolean Delivery_Entry value that indicates whether a Delivery_Entry includes a cash order.
- **Entry_Date**: The date-only value that assigns a Delivery_Entry to a reporting period.
- **Weekly_Report**: A report covering one Monday-through-Sunday calendar week.
- **Monthly_Report**: A report covering one first-through-last-day calendar month.
- **Report_Reference_Date**: A calendar date selected by the Authenticated_User to identify a Weekly_Report or Monthly_Report period.
- **Report_Period**: The inclusive start and end calendar dates resolved from the report type and Report_Reference_Date.
- **Report_Request**: One authenticated submission to generate and email one report.
- **Report_Snapshot**: The immutable set of Delivery_Entry values and calculated totals used by one Report_Request.
- **CSV_Report**: A UTF-8, comma-separated report attachment containing report metadata, delivery-detail records, and summary values.
- **CSV_Grammar**: The comma-separated format in which records are separated by CRLF, fields containing commas, double quotes, or line breaks are enclosed in double quotes, and embedded double quotes are represented by two double quotes.
- **Formula_Trigger**: One of the characters `=`, `+`, `-`, or `@` at the beginning of a text field that a spreadsheet application could interpret as a formula.
- **Email_Provider_Acceptance**: Confirmation from the configured email provider that the provider accepted the email submission for processing.
- **Email_Delivery_Confirmation**: Confirmation from the configured email provider that the report email reached the Account_Email mail system.
- **MYR**: Malaysian ringgit, the currency used for report monetary values.

## Requirements

### Requirement 1: Access the Bulk Report Action

**User Story:** As a delivery driver, I want a clearly identified bulk report action on the dashboard, so that I can start a weekly or monthly CSV email report.

#### Acceptance Criteria

1. WHILE an Authenticated_User is viewing the Dashboard, THE Bulk_Report_Interface SHALL display an action labeled "Bulk Print / Email CSV"
2. WHEN an Authenticated_User activates the bulk report action, THE Bulk_Report_Interface SHALL present exactly two report-type choices labeled "Weekly" and "Monthly"
3. WHEN an Authenticated_User selects either "Weekly" or "Monthly", THE Bulk_Report_Interface SHALL present a control for selecting one Report_Reference_Date
4. WHEN the Bulk_Report_Interface presents the selected report type and Report_Reference_Date for review, THE Bulk_Report_Interface SHALL display the Authenticated_User's Account_Email as the report recipient
5. WHILE the Account_Email is displayed as the report recipient, THE Bulk_Report_Interface SHALL prevent the Authenticated_User from modifying the report recipient
6. WHEN an Authenticated_User submits exactly one of the two displayed report types with a Report_Reference_Date that is a valid calendar date and is not later than the current calendar date, THE Bulk_Report_Interface SHALL create exactly one Report_Request containing that report type, Report_Reference_Date, and Account_Email
7. WHILE a Report_Request for the Authenticated_User has neither reached the sent state nor the failed state, WHEN the Authenticated_User attempts to submit another report selection, THE Bulk_Report_Interface SHALL prevent creation of a new Report_Request and display an indication that the existing Report_Request is in progress

### Requirement 2: Resolve Weekly and Monthly Calendar Periods

**User Story:** As a delivery driver, I want predictable calendar boundaries for weekly and monthly reports, so that I know which delivery dates the report covers.

#### Acceptance Criteria

1. WHEN an Authenticated_User selects a Weekly_Report with a Report_Reference_Date that is on or after 1 January 0001, exists under Gregorian calendar month-length and leap-year rules, and is no later than the current calendar date in the Authenticated_User's time zone at the time of selection, THE Report_Period_Resolver SHALL set the inclusive Report_Period start date to the Monday on or before the Report_Reference_Date
2. WHEN an Authenticated_User selects a Weekly_Report with a Report_Reference_Date that is on or after 1 January 0001, exists under Gregorian calendar month-length and leap-year rules, and is no later than the current calendar date in the Authenticated_User's time zone at the time of selection, THE Report_Period_Resolver SHALL set the inclusive Report_Period end date to the Sunday on or after the Report_Reference_Date
3. WHEN an Authenticated_User selects a Monthly_Report with a Report_Reference_Date that is on or after 1 January 0001, exists under Gregorian calendar month-length and leap-year rules, and is no later than the current calendar date in the Authenticated_User's time zone at the time of selection, THE Report_Period_Resolver SHALL set the inclusive Report_Period start date to the first calendar day of the month containing the Report_Reference_Date
4. WHEN an Authenticated_User selects a Monthly_Report with a Report_Reference_Date that is on or after 1 January 0001, exists under Gregorian calendar month-length and leap-year rules, and is no later than the current calendar date in the Authenticated_User's time zone at the time of selection, THE Report_Period_Resolver SHALL set the inclusive Report_Period end date to the last calendar day of the month containing the Report_Reference_Date
5. WHEN the Report_Period_Resolver resolves a Report_Period, THE Bulk_Report_Interface SHALL display the exact resolved start date and end date, label the displayed range as inclusive, and do so before accepting submission of the Report_Request
6. IF the Report_Reference_Date is absent, is earlier than 1 January 0001, or does not exist under Gregorian calendar month-length and leap-year rules, THEN THE Bulk_Report_Interface SHALL display a validation message indicating the applicable reason, prevent submission of the Report_Request, and leave any previously resolved Report_Period unchanged
7. IF the Report_Reference_Date is later than the current calendar date in the Authenticated_User's time zone at the time submission is attempted, THEN THE Bulk_Report_Interface SHALL display a validation message indicating that future dates are not permitted, reject the Report_Request, and leave any previously resolved Report_Period unchanged

### Requirement 3: Scope and Snapshot Report Data

**User Story:** As a delivery driver, I want reports to contain all and only my delivery data for the selected period, so that emailed income information is complete and private.

#### Acceptance Criteria

1. WHEN a Report_Request is accepted, THE Report_Data_Service SHALL retrieve every Delivery_Entry owned by the Authenticated_User whose Entry_Date is within the inclusive Report_Period
2. WHEN a Report_Request is accepted, THE Report_Data_Service SHALL include every owned Delivery_Entry whose Entry_Date is equal to the Report_Period start date or end date
3. WHEN a Report_Request is accepted, THE Report_Data_Service SHALL include every owned Delivery_Entry whose Entry_Date is later than the Report_Period start date and earlier than the Report_Period end date
4. WHEN a Report_Request is accepted, THE Report_Data_Service SHALL exclude every Delivery_Entry that is not owned by the Authenticated_User or whose Entry_Date is outside the inclusive Report_Period
5. WHEN a Report_Request is accepted, THE Report_Data_Service SHALL apply no Delivery_Entry exclusion based on restaurant status
6. WHEN a Report_Request is accepted, THE Report_Data_Service SHALL apply no Delivery_Entry exclusion based on the value of `has_cash_order`
7. WHEN a Report_Request is accepted, THE Report_Data_Service SHALL retrieve every Delivery_Entry matching the ownership and inclusive Report_Period criteria without applying Dashboard pagination or a record-count limit
8. WHEN the Report_Data_Service finishes retrieving report data, THE Report_Data_Service SHALL create exactly one Report_Snapshot containing exactly one immutable copy of each retrieved Delivery_Entry and no other Delivery_Entry, including when zero Delivery_Entry records were retrieved
9. WHEN a Delivery_Entry is modified or deleted after creation of the Report_Snapshot, THE CSV_Report_Generator SHALL use the Delivery_Entry values stored in the Report_Snapshot
10. WHEN the Report_Snapshot is created, THE Report_Data_Service SHALL derive every report detail record and every report summary value exclusively from that Report_Snapshot
11. IF Report_Snapshot creation fails after successful report data retrieval, THEN THE Bulk_Report_Feature SHALL mark the Report_Request as failed
12. IF Report_Snapshot creation fails after successful report data retrieval, THEN THE Bulk_Report_Feature SHALL make no Report_Snapshot or CSV_Report available for the Report_Request and leave every Delivery_Entry unchanged
13. WHEN the Bulk_Report_Feature marks a Report_Request as failed because Report_Snapshot creation failed, THE Bulk_Report_Interface SHALL display a report-generation failure message

### Requirement 4: Provide Report Detail and Summary Content

**User Story:** As a delivery driver, I want delivery details and income totals in the CSV report, so that I can review and reconcile income for the selected period.

#### Acceptance Criteria

1. THE CSV_Report_Generator SHALL include exactly one metadata value for the report type, Report_Period start date, Report_Period end date, generation timestamp recorded when CSV_Report generation completes, and currency value `MYR` in the CSV_Report
2. THE CSV_Report_Generator SHALL include exactly one detail header for each of Entry_Date, Delivery_Entry timestamp, restaurant name, restaurant status, fare amount, `has_cash_order`, cash amount, and entry total, with each detail record containing its values in the same order as the detail headers
3. WHEN a Delivery_Entry exists in the Report_Snapshot, THE CSV_Report_Generator SHALL produce exactly one detail record containing the corresponding Delivery_Entry values and represent `has_cash_order` as `true` or `false`
4. THE CSV_Report_Generator SHALL order detail records by Entry_Date from latest date to earliest date
5. WHEN two detail records have the same Entry_Date, THE CSV_Report_Generator SHALL order the two detail records by Delivery_Entry timestamp from latest timestamp to earliest timestamp
6. THE CSV_Report_Generator SHALL format each MYR monetary value as a base-10 numeral with a period as the decimal separator, exactly two digits after the decimal separator, no thousands separators, and no currency symbol
7. WHEN a Delivery_Entry has `has_cash_order` equal to false, THE CSV_Report_Generator SHALL represent the cash amount as an empty field regardless of the cash amount stored for the Delivery_Entry
8. WHEN a Delivery_Entry has `has_cash_order` equal to true and a zero cash amount, THE CSV_Report_Generator SHALL represent the cash amount as `0.00`
9. WHEN a Delivery_Entry has `has_cash_order` equal to true, THE CSV_Report_Generator SHALL calculate entry total as fare amount plus cash amount
10. WHEN a Delivery_Entry has `has_cash_order` equal to false, THE CSV_Report_Generator SHALL calculate entry total as fare amount
11. THE CSV_Report_Generator SHALL include exactly one summary value for delivery-record count, digital-income total, cash-income total, halal-income total, and non-halal-income total
12. THE CSV_Report_Generator SHALL calculate digital-income total as the sum of all fare amounts in the Report_Snapshot
13. THE CSV_Report_Generator SHALL calculate cash-income total as the sum of cash amounts for Delivery_Entry records with `has_cash_order` equal to true
14. THE CSV_Report_Generator SHALL calculate halal-income total as the sum of entry totals for Delivery_Entry records with restaurant status `halal`
15. THE CSV_Report_Generator SHALL calculate non-halal-income total as the sum of entry totals for Delivery_Entry records with restaurant status `non-halal`
16. WHEN the Report_Snapshot contains zero Delivery_Entry records, THE CSV_Report_Generator SHALL produce a CSV_Report containing the detail headers, zero detail records, a delivery-record count of `0`, and digital-income, cash-income, halal-income, and non-halal-income totals of `0.00`
17. THE CSV_Report_Generator SHALL format each Entry_Date and Report_Period boundary as `YYYY-MM-DD` and each Delivery_Entry timestamp and generation timestamp in Coordinated Universal Time as `YYYY-MM-DDThh:mm:ssZ`
18. IF a Delivery_Entry has `has_cash_order` equal to true and has no cash amount, THEN THE CSV_Report_Generator SHALL indicate CSV_Report generation failure, produce no CSV_Report, and leave the Report_Snapshot unchanged

### Requirement 5: Generate a Safe and Interoperable CSV Attachment

**User Story:** As a delivery driver, I want the attached report to open safely and preserve delivery values, so that I can use the report in common spreadsheet tools.

#### Acceptance Criteria

1. THE CSV_Report_Generator SHALL encode the entire CSV_Report as valid UTF-8 text without replacing or omitting any character from the Report_Snapshot
2. THE CSV_Report_Generator SHALL format every CSV_Report field and record according to the CSV_Grammar and terminate every record, including the final record, with CRLF
3. WHEN a CSV_Grammar-conforming parser parses the CSV_Report, THE CSV_Report_Generator SHALL provide records and fields without a CSV_Grammar structural error
4. THE CSV_Report_Generator SHALL generate a CSV_Report whose parsed field values reproduce the report metadata, detail values, and summary values from the Report_Snapshot
5. WHEN a text value begins with a Formula_Trigger, THE CSV_Report_Generator SHALL prefix the value with exactly one apostrophe character before applying CSV_Grammar field encoding
6. THE CSV_Report_Generator SHALL assign the CSV_Report a filename in the format `<report-type>_<start-date>_<end-date>.csv`, where `<report-type>` is `weekly` or `monthly` and each date uses the `YYYY-MM-DD` format
7. THE CSV_Report_Generator SHALL identify the CSV_Report media type as `text/csv; charset=UTF-8`
8. THE CSV_Report_Generator SHALL limit CSV_Report content to the metadata, detail fields, and summary values defined in Requirement 4

### Requirement 6: Email the CSV Report to the Account Address

**User Story:** As a delivery driver, I want the generated report sent to my account email, so that I can retain and share the weekly or monthly report from my inbox.

#### Acceptance Criteria

1. THE Report_Email_Service SHALL address each report email only to the Account_Email displayed for the corresponding Report_Request
2. THE Report_Email_Service SHALL attach the completed CSV_Report as the only attachment to the corresponding report email
3. THE Report_Email_Service SHALL include the report type, Report_Period start date, and Report_Period end date in an email subject containing no more than 200 characters
4. THE Report_Email_Service SHALL include labeled values for the report type, Report_Period start date, Report_Period end date, delivery-record count, digital-income total, cash-income total, halal-income total, and non-halal-income total in an email body containing no more than 2,000 characters, with the count and totals equal to the corresponding CSV_Report values
5. WHILE a Report_Request is neither sent nor failed, WHEN the configured email provider returns the first Email_Provider_Acceptance for that Report_Request, THE Report_Email_Service SHALL record the Report_Request as accepted for delivery exactly once
6. WHILE a Report_Request is accepted for delivery and is not failed, WHEN the configured email provider returns Email_Delivery_Confirmation for that Report_Request, THE Report_Email_Service SHALL mark the Report_Request as sent
7. WHEN the Report_Email_Service marks a Report_Request as sent, THE Bulk_Report_Interface SHALL display a success message of no more than 500 characters indicating that the report was sent and containing the Account_Email, Report_Period start date, and Report_Period end date
8. IF the configured email provider rejects a report email before returning Email_Provider_Acceptance for the corresponding Report_Request, THEN THE Report_Email_Service SHALL mark the Report_Request as failed without marking it as sent
9. WHILE a Report_Request is accepted for delivery, IF the configured email provider rejects the report email before returning Email_Delivery_Confirmation for that Report_Request, THE Report_Email_Service SHALL mark the Report_Request as failed without marking it as sent
10. WHEN the Report_Email_Service marks a Report_Request as failed, THE Bulk_Report_Interface SHALL display a failure message of no more than 500 characters indicating that the report was not sent and containing the Account_Email, Report_Period start date, and Report_Period end date
11. IF the configured email provider returns more than one Email_Provider_Acceptance for one Report_Request, THEN THE Report_Email_Service SHALL retain exactly one acceptance record without changing the current Report_Request state
12. WHEN the CSV_Report_Generator completes a CSV_Report for a Report_Request, THE Report_Email_Service SHALL submit exactly one report email for that Report_Request to the configured email provider
13. IF a Report_Request remains neither sent nor failed 300 seconds after the report email is submitted, THEN THE Report_Email_Service SHALL mark the Report_Request as failed
14. WHILE a Report_Request is failed, WHEN the configured email provider later returns Email_Delivery_Confirmation for that Report_Request, THE Report_Email_Service SHALL keep the Report_Request in the failed state

### Requirement 7: Validate and Recover from Report Failures

**User Story:** As a delivery driver, I want clear report errors and safe retry behavior, so that I can recover without assuming an unsent report was delivered.

#### Acceptance Criteria

1. IF a report action lacks a valid authenticated session, THEN THE Bulk_Report_Feature SHALL reject the action without creating a Report_Request and provide an authentication-required error indication
2. IF a report type is absent or is neither Weekly_Report nor Monthly_Report, THEN THE Bulk_Report_Feature SHALL reject the action without creating a Report_Request and provide a report-type validation error indication
3. IF a Report_Reference_Date is absent, is not a valid calendar date, or is later than the current calendar date, THEN THE Bulk_Report_Feature SHALL reject the action without creating a Report_Request and provide a reference-date validation error indication
4. IF report data retrieval for a Report_Request fails, THEN THE Bulk_Report_Interface SHALL display a failure message indicating that report data retrieval failed
5. IF CSV_Report generation for a Report_Request fails, THEN THE Bulk_Report_Interface SHALL display a failure message indicating that CSV_Report generation failed
6. IF report email submission for a Report_Request fails before Email_Delivery_Confirmation, THEN THE Bulk_Report_Interface SHALL display a failure message indicating that email submission failed
7. WHILE a Report_Request has no Email_Delivery_Confirmation, THE Bulk_Report_Interface SHALL withhold every sent-success message for that Report_Request
8. WHEN an Authenticated_User activates the retry control for a failed Report_Request, THE Bulk_Report_Feature SHALL create exactly one new Report_Request using the displayed report type and Report_Reference_Date without changing the failed state of the original Report_Request
9. IF the UTF-8-encoded CSV_Report exceeds the configured email attachment size limit of 10,485,760 bytes, THEN THE Bulk_Report_Feature SHALL fail the Report_Request with a report-size error indication before submitting an email
10. IF an unexpected report error occurs, THEN THE Bulk_Report_Interface SHALL display an unexpected-failure message that contains no internal stack trace, credential, session token, or provider credential
11. WHEN a Report_Request enters the failed state, THE Bulk_Report_Interface SHALL display a failure message identifying data retrieval, CSV_Report generation, email submission, report size, or an unexpected error as the failed stage
12. IF any stage of a Report_Request fails before Email_Delivery_Confirmation, THEN THE Bulk_Report_Interface SHALL withhold every sent-success message for the failed Report_Request
13. WHEN a Report_Request enters the failed state, THE Bulk_Report_Interface SHALL display one retry control for that Report_Request
14. WHILE a failed Report_Request is displayed, THE Bulk_Report_Interface SHALL retain its report type and Report_Reference_Date in the report-selection controls

### Requirement 8: Support Accessible and Responsive Report Interaction

**User Story:** As a delivery driver, I want the bulk report action to work with keyboard, assistive technology, and supported screen sizes, so that I can request reports from the devices I use.

#### Acceptance Criteria

1. THE Bulk_Report_Interface SHALL provide each bulk report action, report-type control, Report_Reference_Date control, submission control, and retry control with a programmatically determinable accessible name that identifies the control's purpose
2. THE Bulk_Report_Interface SHALL permit a user using only keyboard input to move focus to, operate, and move focus away from every report control
3. WHILE a Report_Request is in progress, THE Bulk_Report_Interface SHALL expose a programmatically determinable status indicating that the Report_Request is in progress
4. WHEN a report outcome message appears, THE Bulk_Report_Interface SHALL make the complete message programmatically determinable and notify assistive technology of the message without requiring the user to move keyboard focus
5. WHILE the Dashboard viewport width is between 320 and 2560 CSS pixels inclusive, THE Bulk_Report_Interface SHALL display every report control entirely within the viewport without horizontal viewport scrolling
6. WHILE the Dashboard viewport width is between 320 and 767 CSS pixels inclusive, THE Bulk_Report_Interface SHALL provide an activation area at least 44 CSS pixels wide and 44 CSS pixels high for each bulk report action, submission control, and retry control
7. WHILE the Dashboard viewport width is between 768 and 2560 CSS pixels inclusive, THE Bulk_Report_Interface SHALL keep the existing Dashboard filters, income totals, delivery entries, and New Entry action visible, unobscured by the Bulk_Report_Interface, and operable where interactive without horizontal viewport scrolling