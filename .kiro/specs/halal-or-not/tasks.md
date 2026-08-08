# Implementation Plan: HalalOrNot Income Tracking System

## Overview

This implementation plan breaks down the HalalOrNot Income Tracking System into discrete, actionable coding tasks. The system is a cloud-based web application built with React (frontend), Node.js/Express (backend), PostgreSQL (database), and AWS infrastructure. The implementation follows a logical progression: infrastructure setup → authentication → backend services → frontend components → integration → deployment.

## Tasks

- [x] 1. Set up project structure and development environment
  - Initialize monorepo or separate frontend/backend repositories
  - Set up TypeScript configuration for both frontend and backend
  - Configure ESLint, Prettier, and other code quality tools
  - Set up environment variable management (.env files)
  - Initialize package.json with core dependencies (React, Express, Prisma, etc.)
  - Configure build scripts and development servers
  - _Requirements: 10.1, 10.5_

- [x] 2. Configure database and ORM
  - [x] 2.1 Set up PostgreSQL database schema using Prisma
    - Create Prisma schema with User, IncomeCategory, IncomeEntry, SessionToken, and AuditLog models
    - Configure database connection string with encryption
    - Generate initial migration files
    - _Requirements: 7.8, 11.1, 11.2_

  - [ ]* 2.2 Write property test for database connection configuration
    - **Property 11: Database Error Logging**
    - **Validates: Requirements 7.7**

  - [x] 2.3 Implement Database Client with connection pooling
    - Create DatabaseClient class with connection management (5-20 connections)
    - Implement retry logic with exponential backoff (3 attempts)
    - Add transaction management with automatic rollback on failure
    - Implement prepared statement execution
    - _Requirements: 7.5, 11.3, 11.4, 11.5, 11.6_

  - [ ]* 2.4 Write property tests for transaction atomicity and SQL injection prevention
    - **Property 10: Transaction Atomicity**
    - **Property 20: SQL Injection Prevention**
    - **Validates: Requirements 7.5, 11.5**

- [x] 3. Implement authentication system
  - [x] 3.1 Set up AWS Cognito integration or implement JWT-based authentication
    - Create AuthenticationService class
    - Implement password hashing with bcrypt
    - Implement JWT token generation with 30-minute expiration
    - Configure token refresh mechanism
    - _Requirements: 1.1, 1.2, 1.4_

  - [x] 3.2 Create authentication middleware for API endpoints
    - Implement token validation middleware
    - Add session timeout detection (30 minutes)
    - Implement user data isolation checks
    - _Requirements: 1.3, 1.5_

  - [ ]* 3.3 Write property test for user data isolation
    - **Property 1: User Data Isolation**
    - **Validates: Requirements 1.5**

  - [x] 3.4 Create authentication API endpoints
    - Implement POST /api/auth/login
    - Implement POST /api/auth/logout
    - Implement GET /api/auth/session
    - Add error handling for invalid credentials and expired sessions
    - _Requirements: 1.1, 1.2, 1.3_

- [x] 4. Checkpoint - Ensure authentication tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement delivery entry data models and validation
  - [x] 5.1 Create delivery entry interfaces and types
    - Define DeliveryEntry interface with restaurant name, restaurant status, fare amount, cash order indicator, cash amount, date, timestamp
    - Define validation rules for restaurant name (non-empty, max 100 chars)
    - Define validation rules for amounts (numeric, > 0, max 2 decimals)
    - Define validation rules for restaurant status ("halal" or "non-halal")
    - _Requirements: 2.7, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4, 9.1, 9.2_

  - [ ]* 5.2 Write property tests for restaurant name validation
    - **Property 6: Restaurant Name Input Validation**
    - **Property 7: Restaurant Name Preservation**
    - **Validates: Requirements 5.1, 5.2, 5.5**

  - [ ]* 5.3 Write property tests for amount validation
    - **Property 9: Amount Input Validation**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6**

- [x] 6. Implement Income Service with core business logic
  - [x] 6.1 Create IncomeService class with CRUD operations
    - Implement createEntry method
    - Implement updateEntry method with re-categorization
    - Implement deleteEntry method
    - Implement getEntries method with filtering
    - Implement calculateTotals method for aggregations
    - _Requirements: 2.7, 3.1, 3.2, 3.3, 8.1, 8.2, 8.3, 8.4_

  - [x] 6.2 Implement automatic income segregation logic
    - Calculate Halal_Income for entries with restaurantStatus "halal"
    - Calculate NonHalal_Income for entries with restaurantStatus "non-halal"
    - Include both fare amount and cash amount in calculations
    - Calculate total cash income and total digital income separately
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.3, 4.4, 4.5_

  - [ ]* 6.3 Write property tests for income segregation and aggregation
    - **Property 3: Restaurant Status Categorization**
    - **Property 4: Income Aggregation Accuracy**
    - **Property 5: Payment Type Classification and Aggregation**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.3, 4.4, 4.5**

  - [x] 6.4 Implement duplicate detection logic
    - Check for entries with matching date, restaurant name, and amounts
    - Return boolean indicating potential duplicate
    - _Requirements: (implicit from design duplicate detection)_

  - [x] 6.5 Implement autocomplete functionality for restaurant names
    - Store previously entered restaurant names
    - Return up to 10 matching suggestions based on search query
    - _Requirements: 5.3, 5.4_

  - [ ]* 6.6 Write property test for autocomplete matching
    - **Property 8: Autocomplete Matching**
    - **Validates: Requirements 5.4**

- [x] 7. Create income entry API endpoints
  - [x] 7.1 Implement POST /api/income-entries
    - Accept DeliveryEntry data in request body
    - Validate input data
    - Call IncomeService.createEntry
    - Return created entry with 201 status
    - Ensure database write completes within 2 seconds
    - _Requirements: 2.7, 7.1_

  - [x] 7.2 Implement GET /api/income-entries with filtering
    - Accept query parameters: startDate, endDate, restaurantStatus, paymentType, limit, offset
    - Call IncomeService.getEntries with filters
    - Return paginated list of entries in reverse chronological order
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 7.3 Implement PUT /api/income-entries/:id
    - Accept partial DeliveryEntry data in request body
    - Validate ownership (user can only update their own entries)
    - Call IncomeService.updateEntry
    - Re-apply income segregation based on updated restaurant status
    - _Requirements: 14.1, 14.2_

  - [x] 7.4 Implement DELETE /api/income-entries/:id
    - Validate ownership (user can only delete their own entries)
    - Call IncomeService.deleteEntry
    - Recalculate all income totals
    - _Requirements: 14.3, 14.4_

  - [ ]* 7.5 Write property tests for database persistence
    - **Property 12: Delivery Entry Round-Trip Persistence**
    - **Validates: Requirements 7.8**

  - [ ]* 7.6 Write property tests for entry editing and deletion
    - **Property 27: Entry Edit Pre-Fill**
    - **Property 28: Entry Update Re-Categorization**
    - **Property 29: Entry Deletion Recalculation**
    - **Property 30: Audit Timestamp Recording**
    - **Validates: Requirements 14.1, 14.2, 14.4, 14.5**

- [x] 8. Implement analytics and aggregation endpoints
  - [x] 8.1 Create GET /api/analytics/totals endpoint
    - Accept query parameters: startDate, endDate, restaurantStatus, paymentType
    - Calculate total Halal_Income, NonHalal_Income, cash income, digital income
    - Return breakdown by restaurant status and payment type
    - _Requirements: 8.5, 8.6, 8.7_

  - [ ]* 8.2 Write property tests for filtering and aggregation
    - **Property 13: Entry List Sorting**
    - **Property 14: Date Range Filtering**
    - **Property 15: Status and Payment Type Filtering**
    - **Property 16: Filtered Income Aggregation**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7**

  - [x] 8.3 Implement CSV export functionality (optional)
    - Create GET /api/income-entries/export endpoint
    - Convert filtered entries to CSV format
    - Return file download response
    - _Requirements: 8.8_

  - [ ]* 8.4 Write property test for CSV export round-trip
    - **Property 17: CSV Export Round-Trip**
    - **Validates: Requirements 8.8**

- [x] 9. Checkpoint - Ensure backend services and tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Create React frontend project structure
  - Initialize React app with TypeScript
  - Set up TailwindCSS for responsive design
  - Configure React Router for navigation
  - Set up React Query for data fetching
  - Configure React Hook Form for form handling
  - Create folder structure: components, pages, hooks, services, types
  - _Requirements: 10.1, 10.2, 10.3_

- [x] 11. Implement authentication UI components
  - [x] 11.1 Create LoginForm component
    - Email and password input fields
    - Form validation with error messages
    - Submit handler calling POST /api/auth/login
    - Store JWT token in localStorage or secure cookie
    - Redirect to dashboard on success
    - _Requirements: 1.1, 1.2_

  - [x] 11.2 Create authentication context and hooks
    - Create useAuth hook for managing authentication state
    - Implement automatic token refresh before expiration
    - Implement session timeout detection with 5-minute warning
    - Implement automatic re-authentication on session expiry
    - _Requirements: 1.3_

  - [ ]* 11.3 Write unit tests for authentication components
    - Test login form validation
    - Test error message display
    - Test redirect behavior
    - _Requirements: 1.1, 1.2_

- [x] 12. Implement five-step delivery entry workflow
  - [x] 12.1 Create EntryWorkflow component with step management
    - Create state management for current step (1-5)
    - Implement step navigation (Next, Back buttons)
    - Display progress indicators (e.g., "Step 2 of 5")
    - Preserve entered values when navigating between steps
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 2.9_

  - [ ]* 12.2 Write property test for workflow state preservation
    - **Property 19: Workflow State Preservation**
    - **Validates: Requirements 9.4, 9.5**

  - [x] 12.3 Create Step 1: Restaurant Name Input component
    - Text input field (max 100 characters)
    - Implement autocomplete with previous restaurant names
    - Fetch restaurant name suggestions from backend
    - Display validation error for empty input
    - Prevent progression to Step 2 without valid input
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 9.3_

  - [x] 12.4 Create Step 2: Restaurant Status Selection component
    - Display two options: "halal" and "non-halal"
    - Visual indication of selected option
    - Prevent progression without selection
    - Preserve selection when navigating back
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [ ]* 12.5 Write property test for workflow validation
    - **Property 18: Workflow Validation**
    - **Validates: Requirements 9.3**

  - [x] 12.6 Create Step 3: Fare Amount Input component
    - Numeric input field with validation
    - Display error for amounts <= 0 or > 2 decimal places
    - Prevent progression without valid amount
    - _Requirements: 6.1, 6.2, 6.5, 6.6_

  - [x] 12.7 Create Step 4: Cash Order Selection component
    - Display "Yes" and "No" options
    - Conditionally show Step 5 if "Yes" selected
    - Skip Step 5 and proceed to save if "No" selected
    - _Requirements: 2.4, 2.5, 2.6, 4.2_

  - [ ]* 12.8 Write property test for conditional workflow display
    - **Property 2: Conditional Workflow Display**
    - **Validates: Requirements 2.5, 2.6**

  - [x] 12.9 Create Step 5: Cash Amount Input component
    - Numeric input field with validation (same as Step 3)
    - Display error for amounts <= 0 or > 2 decimal places
    - Required field when cash order is "Yes"
    - _Requirements: 4.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 12.10 Implement form submission and entry creation
    - Call POST /api/income-entries on completion
    - Handle success (redirect to dashboard, show confirmation)
    - Handle errors (display error messages, preserve form state)
    - _Requirements: 2.7_

- [x] 13. Implement automatic date assignment and timezone handling
  - [x] 13.1 Add automatic date assignment to entry creation
    - Default entry date to current date
    - Allow manual date input for past dates
    - Validate no future dates allowed
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [ ]* 13.2 Write property tests for date assignment and validation
    - **Property 21: Automatic Date Assignment**
    - **Property 22: Past Date Acceptance and Future Date Rejection**
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4**

  - [x] 13.3 Implement timezone display logic
    - Convert timestamps to user's local timezone
    - Display formatted dates and times
    - _Requirements: 12.5_

  - [ ]* 13.4 Write property test for timezone display
    - **Property 23: Timezone Display**
    - **Validates: Requirements 12.5**

- [x] 14. Create dashboard and data viewing components
  - [x] 14.1 Create Dashboard component
    - Display list of delivery entries in reverse chronological order
    - Implement pagination (limit/offset)
    - Display total Halal_Income, NonHalal_Income, cash income, and digital income
    - _Requirements: 8.1, 8.5, 8.6, 8.7_

  - [x] 14.2 Create FilterPanel component
    - Date range filter (start date, end date)
    - Restaurant status filter (halal, non-halal, both)
    - Payment type filter (cash, digital, both)
    - Apply filters to dashboard display
    - _Requirements: 8.2, 8.3, 8.4, 4.7_

  - [x] 14.3 Implement entry editing functionality
    - Add "Edit" button to each entry
    - Pre-fill EntryWorkflow with existing values
    - Call PUT /api/income-entries/:id on submission
    - _Requirements: 14.1, 14.2_

  - [x] 14.4 Implement entry deletion functionality
    - Add "Delete" button to each entry
    - Show confirmation dialog before deletion
    - Call DELETE /api/income-entries/:id
    - Refresh dashboard after deletion
    - _Requirements: 14.3, 14.4_

- [x] 15. Implement error handling and user feedback
  - [x] 15.1 Create ErrorBoundary component for React errors
    - Catch and display unexpected errors
    - Provide user-friendly error messages

  - [x] 15.2 Add API error handling to all data-fetching hooks
    - Display validation errors inline in forms
    - Show toast notifications for success/error messages
    - Implement retry logic for transient failures
    - _Requirements: (error handling from design)_

  - [x] 15.3 Implement session expiration handling
    - Display warning 5 minutes before session expires
    - Redirect to login on session expiry
    - Preserve form state in localStorage for restoration after login
    - _Requirements: 1.3_

- [x] 16. Checkpoint - Ensure frontend components and tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 17. Implement responsive design and accessibility
  - [x] 17.1 Optimize layout for mobile devices (320px-768px)
    - Mobile-optimized entry workflow for single-handed input
    - Responsive navigation and dashboard layout
    - Touch-friendly button sizes and spacing
    - _Requirements: 10.2, 10.3, 10.6_

  - [x] 17.2 Optimize layout for tablet and desktop (768px-2560px)
    - Multi-column dashboard layout
    - Side-by-side filter panel and entry list
    - _Requirements: 10.2_

  - [~] 17.3 Implement accessibility features
    - Keyboard navigation support
    - ARIA labels for screen readers
    - Color contrast compliance (WCAG AA)
    - _Requirements: (accessibility from design)_

- [ ] 18. Set up AWS infrastructure and deployment
  - [~] 18.1 Configure AWS RDS PostgreSQL instance
    - Create Multi-AZ RDS PostgreSQL database
    - Configure automated daily backups at 2 AM
    - Set up VPC and security groups
    - _Requirements: 7.4, 13.4_

  - [~] 18.2 Set up AWS Lambda or ECS for backend API
    - Deploy Express API to AWS Lambda or ECS Fargate
    - Configure API Gateway for REST endpoints
    - Set up RDS Proxy for connection pooling
    - _Requirements: 11.6_

  - [~] 18.3 Deploy React frontend to AWS S3 + CloudFront
    - Build production React app
    - Upload build artifacts to S3
    - Configure CloudFront for global CDN delivery
    - Set up HTTPS/SSL with ACM certificate
    - _Requirements: 10.4, 13.1_

  - [~] 18.4 Configure AWS Cognito for authentication (if using Cognito)
    - Create Cognito User Pool
    - Configure JWT token settings (30-minute expiration)
    - Integrate with API Gateway authorizer
    - _Requirements: 1.3, 1.4_

  - [~] 18.5 Set up monitoring and logging
    - Configure CloudWatch for application logs
    - Set up CloudWatch Alarms for 99% uptime monitoring
    - Configure AWS X-Ray for distributed tracing
    - Set up AWS Secrets Manager for credentials
    - _Requirements: 13.2, 13.3_

- [~] 19. Final checkpoint - End-to-end testing and deployment verification
  - Ensure all tests pass, ask the user if questions arise.
  - Verify dashboard loads within 3 seconds
  - Verify database writes complete within 2 seconds
  - Test complete user workflow from login to entry creation to dashboard viewing

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP delivery
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation throughout the implementation process
- Property-based tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The implementation uses TypeScript throughout for type safety
- AWS infrastructure tasks (section 18) can be replaced with other cloud providers if needed
- **Migration-related functionality has been removed per user request** - no CSV import, Google Sheets migration, or Migration Service tasks are included

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "2.3"] },
    { "id": 2, "tasks": ["2.2", "2.4", "3.1"] },
    { "id": 3, "tasks": ["3.2", "3.4"] },
    { "id": 4, "tasks": ["3.3", "5.1"] },
    { "id": 5, "tasks": ["5.2", "5.3", "6.1", "6.2", "6.4", "6.5"] },
    { "id": 6, "tasks": ["6.3", "6.6", "7.1", "7.2", "7.3", "7.4"] },
    { "id": 7, "tasks": ["7.5", "7.6", "8.1"] },
    { "id": 8, "tasks": ["8.2", "8.3"] },
    { "id": 9, "tasks": ["8.4", "10"] },
    { "id": 10, "tasks": ["11.1", "11.2"] },
    { "id": 11, "tasks": ["11.3", "12.1"] },
    { "id": 12, "tasks": ["12.2", "12.3", "12.4", "12.6", "12.7", "12.9"] },
    { "id": 13, "tasks": ["12.5", "12.8", "12.10", "13.1"] },
    { "id": 14, "tasks": ["13.2", "13.3"] },
    { "id": 15, "tasks": ["13.4", "14.1", "14.2", "14.3", "14.4"] },
    { "id": 16, "tasks": ["15.1", "15.2", "15.3"] },
    { "id": 17, "tasks": ["17.1", "17.2", "17.3"] },
    { "id": 18, "tasks": ["18.1", "18.2", "18.3", "18.4", "18.5"] }
  ]
}
```
