# Frontend Utilities

This directory contains utility functions used across the frontend application.

## Date Formatting (`dateFormat.ts`)

Timezone-aware date and time formatting utilities that convert timestamps to the user's local timezone.

**Validates: Requirement 12.5 - Display timestamps in delivery driver's local timezone**

### Available Functions

#### `formatDateTime(date: Date | string): string`
Formats a date with both date and time in the user's local timezone.

**Example:**
```typescript
formatDateTime(new Date('2024-01-15T15:45:00.000Z'))
// Output (US Eastern): "Jan 15, 2024, 10:45 AM"
// Output (UTC): "Jan 15, 2024, 3:45 PM"
```

#### `formatDate(date: Date | string): string`
Formats a date without time in the user's local timezone.

**Example:**
```typescript
formatDate(new Date('2024-01-15T15:45:00.000Z'))
// Output: "Jan 15, 2024"
```

#### `formatTime(date: Date | string): string`
Formats only the time portion in the user's local timezone.

**Example:**
```typescript
formatTime(new Date('2024-01-15T15:45:00.000Z'))
// Output (US Eastern): "10:45 AM"
// Output (UTC): "3:45 PM"
```

#### `formatDateLong(date: Date | string): string`
Formats a date with day of week in the user's local timezone.

**Example:**
```typescript
formatDateLong(new Date('2024-01-15T00:00:00.000Z'))
// Output: "Monday, January 15, 2024"
```

#### `formatRelativeTime(date: Date | string): string`
Formats a date as relative time (e.g., "2 hours ago", "yesterday").

**Example:**
```typescript
// If current time is 2024-01-15T15:30:00
formatRelativeTime(new Date('2024-01-15T13:30:00.000Z'))
// Output: "2 hours ago"

formatRelativeTime(new Date('2024-01-14T15:30:00.000Z'))
// Output: "yesterday"

formatRelativeTime(new Date('2024-01-01T15:30:00.000Z'))
// Output: "Jan 1, 2024" (for dates older than a week)
```

#### `formatTimestamp(date: Date | string): string`
Combines formatted date with relative time for comprehensive timestamp display.

**Example:**
```typescript
formatTimestamp(new Date('2024-01-15T13:30:00.000Z'))
// Output: "Jan 15, 2024 (2 hours ago)"

formatTimestamp(new Date('2024-01-01T15:30:00.000Z'))
// Output: "Jan 1, 2024" (no relative time for old dates)
```

### Implementation Details

All formatting functions use JavaScript's built-in `Intl.DateTimeFormat` API, which:

- Automatically detects and uses the user's browser/system timezone
- Converts UTC timestamps to local time
- Respects the user's locale settings
- Provides consistent formatting across browsers

### Usage in Components

```typescript
import { formatDate, formatDateTime, formatTimestamp } from '../utils/dateFormat';

function MyComponent({ entry }) {
  return (
    <div>
      <p>Entry Date: {formatDate(entry.entryDate)}</p>
      <p>Created: {formatTimestamp(entry.createdAt)}</p>
      <p title={formatDateTime(entry.updatedAt)}>
        Last Updated: {formatRelativeTime(entry.updatedAt)}
      </p>
    </div>
  );
}
```

### Testing

All functions are fully tested in `dateFormat.test.ts` with:
- Unit tests for each formatting function
- Timezone conversion verification
- Edge case handling (past dates, different years, etc.)
- Relative time calculations

Run tests with:
```bash
npm test -- dateFormat.test.ts
```

### Browser Compatibility

The `Intl.DateTimeFormat` API is supported in all modern browsers:
- Chrome 24+
- Firefox 29+
- Safari 10+
- Edge 12+

No polyfills are required for our target browsers.
