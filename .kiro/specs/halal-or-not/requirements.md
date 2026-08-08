# Requirements Document

## Introduction

The HalalOrNot system is a web-based income segregation application that replaces the existing iOS Shortcuts-based solution with Google Sheets backend. The system enables users to categorize and track different types of income through a cloud-accessible web interface, with persistent storage in a cloud-hosted database for reliable data management, querying, and analysis.

## Glossary

- **Income_Tracker**: The web-based system that manages income segregation
- **User**: A person who records and categorizes their income using the system
- **Income_Entry**: A single record containing income amount, category, date, and metadata
- **Income_Category**: A classification type for income (e.g., salary, freelance, halal, non-halal)
- **Data_Store**: The cloud-hosted database (e.g., PostgreSQL, MySQL, or MongoDB) that persists income data
- **Web_Interface**: The browser-based user interface for data entry and viewing
- **Authentication_Service**: The component that verifies user identity and manages access
- **Database_Client**: The component that manages database connections and executes queries

## Requirements

### Requirement 1: User Authentication and Access Control

**User Story:** As a delivery driver, I want to securely log into the system, so that only I can access my income data.

#### Acceptance Criteria

1. WHEN a delivery driver provides valid credentials, THE Authentication_Service SHALL grant access to the Web_Interface
2. WHEN a delivery driver provides invalid credentials, THE Authentication_Service SHALL deny access and display an error message
3. WHEN a delivery driver session expires after 30 minutes of inactivity, THE Authentication_Service SHALL require re-authentication
4. THE Authentication_Service SHALL encrypt delivery driver credentials using industry-standard encryption
5. WHERE multi-user support is enabled, THE Authentication_Service SHALL isolate each delivery driver's data from other users

### Requirement 2: Five-Step Delivery Entry Workflow

**User Story:** As a delivery driver, I want to record delivery income through a guided step-by-step workflow, so that I can quickly and accurately capture all relevant details for each delivery.

#### Acceptance Criteria

1. WHEN a delivery driver starts a new entry, THE Entry_Workflow SHALL display Step 1 requesting the restaurant name
2. WHEN a delivery driver completes Step 1, THE Entry_Workflow SHALL display Step 2 requesting the Restaurant_Status (halal or non-halal)
3. WHEN a delivery driver completes Step 2, THE Entry_Workflow SHALL display Step 3 requesting the Fare_Amount earned
4. WHEN a delivery driver completes Step 3, THE Entry_Workflow SHALL display Step 4 requesting whether there was a cash order (yes/no)
5. WHEN a delivery driver answers "yes" to Step 4, THE Entry_Workflow SHALL display Step 5 requesting the Cash_Amount earned
6. WHEN a delivery driver answers "no" to Step 4, THE Entry_Workflow SHALL skip Step 5 and proceed to save the Delivery_Entry
7. WHEN a delivery driver completes all required steps, THE Income_Tracker SHALL create a Delivery_Entry with restaurant name, Restaurant_Status, Fare_Amount, cash order status, Cash_Amount (if applicable), date, and timestamp
8. THE Entry_Workflow SHALL allow delivery drivers to navigate back to previous steps to correct input
9. THE Entry_Workflow SHALL display progress indicators showing which step the delivery driver is currently on (e.g., "Step 2 of 5")

### Requirement 3: Automatic Income Segregation

**User Story:** As a delivery driver, I want the system to automatically categorize my income as halal or non-halal based on the restaurant status, so that I don't have to manually assign categories.

#### Acceptance Criteria

1. WHEN a Delivery_Entry has Restaurant_Status "halal", THE Income_Tracker SHALL classify all income from that entry as Halal_Income
2. WHEN a Delivery_Entry has Restaurant_Status "non-halal", THE Income_Tracker SHALL classify all income from that entry as NonHalal_Income
3. WHEN calculating income segregation, THE Income_Tracker SHALL include both Fare_Amount and Cash_Amount (if present) in the categorization
4. THE Income_Tracker SHALL calculate total Halal_Income by summing all Fare_Amount and Cash_Amount values from entries with Restaurant_Status "halal"
5. THE Income_Tracker SHALL calculate total NonHalal_Income by summing all Fare_Amount and Cash_Amount values from entries with Restaurant_Status "non-halal"
6. WHEN displaying a Delivery_Entry, THE Income_Tracker SHALL show the automatically assigned income category (Halal_Income or NonHalal_Income)

### Requirement 4: Cash and Digital Payment Tracking

**User Story:** As a delivery driver, I want to track both cash and digital payments separately, so that I understand the payment breakdown of my income.

#### Acceptance Criteria

1. WHEN a delivery driver records a Fare_Amount, THE Income_Tracker SHALL treat it as digital payment income
2. WHEN a delivery driver indicates a cash order exists, THE Income_Tracker SHALL require Cash_Amount input before allowing entry completion
3. WHEN a delivery driver records a Cash_Amount, THE Income_Tracker SHALL store it separately from the Fare_Amount
4. THE Income_Tracker SHALL calculate total cash income by summing all Cash_Amount values across all Delivery_Entry records
5. THE Income_Tracker SHALL calculate total digital income by summing all Fare_Amount values across all Delivery_Entry records
6. WHEN displaying income summaries, THE Income_Tracker SHALL show separate totals for cash and digital payments
7. THE Income_Tracker SHALL allow filtering by payment type (cash only, digital only, or both)

### Requirement 5: Restaurant Name Input and Validation

**User Story:** As a delivery driver, I want to enter restaurant names easily, so that I can quickly record which restaurant each delivery was from.

#### Acceptance Criteria

1. WHEN a delivery driver enters a restaurant name in Step 1, THE Income_Tracker SHALL accept text input up to 100 characters
2. WHEN a delivery driver submits an empty restaurant name, THE Income_Tracker SHALL display a validation error and prevent progression to Step 2
3. THE Income_Tracker SHALL store previously entered restaurant names for autocomplete suggestions
4. WHEN a delivery driver begins typing a restaurant name, THE Income_Tracker SHALL display up to 10 matching suggestions from previous entries
5. THE Income_Tracker SHALL preserve the exact capitalization and spelling as entered by the delivery driver

### Requirement 6: Fare Amount and Cash Amount Input Validation

**User Story:** As a delivery driver, I want the system to validate my income amounts, so that I maintain accurate records without data entry errors.

#### Acceptance Criteria

1. WHEN a delivery driver enters a Fare_Amount in Step 3, THE Income_Tracker SHALL accept only numeric values with up to 2 decimal places
2. WHEN a delivery driver enters a Fare_Amount less than or equal to zero, THE Income_Tracker SHALL display a validation error
3. WHEN a delivery driver enters a Cash_Amount in Step 5, THE Income_Tracker SHALL accept only numeric values with up to 2 decimal places
4. WHEN a delivery driver enters a Cash_Amount less than or equal to zero, THE Income_Tracker SHALL display a validation error
5. THE Income_Tracker SHALL prevent progression to the next step until valid amount input is provided
6. WHEN amount validation fails, THE Income_Tracker SHALL display specific error messages indicating the issue (e.g., "Amount must be greater than zero")

### Requirement 7: Database Persistence for Delivery Entries

**User Story:** As a delivery driver, I want my delivery entries automatically saved to a database, so that I have a persistent, reliable, and queryable record of all my income.

#### Acceptance Criteria

1. WHEN a delivery driver completes the Entry_Workflow, THE Database_Client SHALL write the Delivery_Entry to the Data_Store within 2 seconds
2. WHEN a delivery driver updates a Delivery_Entry, THE Database_Client SHALL update the corresponding record in the Data_Store within 2 seconds
3. WHEN a delivery driver deletes a Delivery_Entry, THE Database_Client SHALL remove the record from the Data_Store or mark it as deleted based on soft-delete configuration
4. IF the Data_Store is temporarily unavailable, THEN THE Database_Client SHALL return an error message to the delivery driver and log the failure
5. WHEN a database transaction fails, THE Database_Client SHALL rollback any partial changes to maintain data integrity
6. THE Database_Client SHALL use connection pooling to manage database connections efficiently
7. THE Database_Client SHALL log all database errors with timestamps and error details
8. WHEN saving a Delivery_Entry, THE Database_Client SHALL store restaurant name, Restaurant_Status, Fare_Amount, cash order indicator, Cash_Amount (nullable), entry date, and timestamp

### Requirement 8: Income Data Viewing and Filtering

**User Story:** As a delivery driver, I want to view and filter my delivery entries, so that I can analyze my income patterns by restaurant, halal status, payment type, and time period.

#### Acceptance Criteria

1. THE Income_Tracker SHALL display delivery entries in reverse chronological order by default
2. WHEN a delivery driver selects a date range filter, THE Income_Tracker SHALL display only Delivery_Entry records within that range
3. WHEN a delivery driver selects a halal status filter, THE Income_Tracker SHALL display only Delivery_Entry records matching that Restaurant_Status
4. WHEN a delivery driver selects a payment type filter, THE Income_Tracker SHALL display entries with cash payments only, digital payments only, or both
5. THE Income_Tracker SHALL calculate and display total Halal_Income for the selected time period
6. THE Income_Tracker SHALL calculate and display total NonHalal_Income for the selected time period
7. THE Income_Tracker SHALL calculate and display total cash income and total digital income for the selected time period
8. WHERE export functionality is enabled, THE Income_Tracker SHALL allow delivery drivers to download filtered data as CSV

### Requirement 9: Restaurant Status Selection

**User Story:** As a delivery driver, I want to select whether a restaurant is halal or non-halal, so that my income is correctly categorized.

#### Acceptance Criteria

1. WHEN a delivery driver reaches Step 2, THE Income_Tracker SHALL display exactly two options: "halal" and "non-halal"
2. WHEN a delivery driver selects a Restaurant_Status, THE Income_Tracker SHALL visually indicate the selection
3. THE Income_Tracker SHALL require Restaurant_Status selection before allowing progression to Step 3
4. WHEN a delivery driver returns to Step 2 to change the selection, THE Income_Tracker SHALL preserve the previously selected value
5. THE Income_Tracker SHALL store the Restaurant_Status exactly as selected (case-sensitive: "halal" or "non-halal")

### Requirement 10: Web Interface Accessibility and Responsiveness

**User Story:** As a delivery driver, I want to access the system from any device with a browser, so that I can record delivery entries immediately after completing a delivery.

#### Acceptance Criteria

1. THE Web_Interface SHALL be accessible through modern web browsers including Chrome, Firefox, Safari, and Edge
2. THE Web_Interface SHALL adapt to screen sizes ranging from 320px to 2560px width
3. WHEN a delivery driver accesses the system from a mobile device, THE Web_Interface SHALL display a mobile-optimized layout
4. THE Web_Interface SHALL load the main dashboard within 3 seconds on a standard broadband connection
5. THE Web_Interface SHALL function without requiring installation of additional software or plugins
6. THE Web_Interface SHALL optimize the Entry_Workflow for quick single-handed mobile input

### Requirement 11: Database Connection and Configuration

**User Story:** As a system administrator, I want to configure secure database connections, so that the application can reliably persist data with proper security controls.

#### Acceptance Criteria

1. WHEN the Income_Tracker starts, THE Database_Client SHALL establish a connection to the Data_Store using encrypted connection strings
2. WHEN database credentials are stored, THE Income_Tracker SHALL encrypt sensitive connection parameters
3. THE Database_Client SHALL support connection timeout configuration with a default of 30 seconds
4. IF the database connection fails during startup, THEN THE Income_Tracker SHALL log the error and retry connection up to 3 times with exponential backoff
5. THE Database_Client SHALL use prepared statements or parameterized queries to prevent SQL injection attacks
6. WHERE connection pooling is configured, THE Database_Client SHALL maintain minimum 5 and maximum 20 concurrent connections

### Requirement 12: Entry Date and Timestamp Management

**User Story:** As a delivery driver, I want each entry to be automatically timestamped, so that I have an accurate chronological record without manual date entry.

#### Acceptance Criteria

1. WHEN a delivery driver completes a Delivery_Entry, THE Income_Tracker SHALL automatically set the entry date to the current date
2. WHEN a delivery driver completes a Delivery_Entry, THE Income_Tracker SHALL automatically record a timestamp with date and time
3. WHERE manual date entry is enabled, THE Income_Tracker SHALL allow delivery drivers to specify a past date for the entry
4. WHEN a delivery driver specifies a past date, THE Income_Tracker SHALL prevent dates in the future
5. THE Income_Tracker SHALL display timestamps in the delivery driver's local timezone

### Requirement 13: Cloud Hosting and Availability

**User Story:** As a delivery driver, I want the system to be available whenever I need it, so that I can record income immediately after completing a delivery.

#### Acceptance Criteria

1. THE Income_Tracker SHALL be hosted on a cloud platform accessible via HTTPS
2. THE Income_Tracker SHALL maintain 99% uptime during delivery hours (6 AM to 11 PM local time)
3. WHEN the system is unavailable, THE Income_Tracker SHALL display a maintenance message
4. THE Income_Tracker SHALL complete backup operations daily at 2 AM local time
5. WHERE high availability is enabled, THE Income_Tracker SHALL failover to backup infrastructure within 5 minutes of primary failure

### Requirement 14: Delivery Entry Editing and Deletion

**User Story:** As a delivery driver, I want to edit or delete delivery entries, so that I can correct mistakes or remove erroneous records.

#### Acceptance Criteria

1. WHEN a delivery driver selects a Delivery_Entry for editing, THE Income_Tracker SHALL display the Entry_Workflow pre-filled with existing values
2. WHEN a delivery driver updates a Delivery_Entry, THE Income_Tracker SHALL re-apply automatic income segregation based on the updated Restaurant_Status
3. WHEN a delivery driver deletes a Delivery_Entry, THE Income_Tracker SHALL prompt for confirmation before deletion
4. WHEN a Delivery_Entry is deleted, THE Income_Tracker SHALL recalculate all income totals to reflect the removal
5. THE Income_Tracker SHALL record an audit timestamp for when a Delivery_Entry was last modified
