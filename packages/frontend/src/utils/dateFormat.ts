/**
 * Date formatting utilities for timezone-aware display
 * Validates Requirement 12.5: Display timestamps in delivery driver's local timezone
 */

/**
 * Formats a date to the user's local timezone with full date and time
 * @param date - Date object or ISO string to format
 * @returns Formatted string like "Jan 15, 2024, 3:45 PM"
 */
export function formatDateTime(date: Date | string): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(dateObj);
}

/**
 * Formats a date to the user's local timezone (date only, no time)
 * @param date - Date object or ISO string to format
 * @returns Formatted string like "Jan 15, 2024"
 */
export function formatDate(date: Date | string): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(dateObj);
}

/**
 * Formats a date to the user's local timezone (time only, no date)
 * @param date - Date object or ISO string to format
 * @returns Formatted string like "3:45 PM"
 */
export function formatTime(date: Date | string): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(dateObj);
}

/**
 * Formats a date to a long format with day of week
 * @param date - Date object or ISO string to format
 * @returns Formatted string like "Monday, January 15, 2024"
 */
export function formatDateLong(date: Date | string): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(dateObj);
}

/**
 * Formats a date as a relative time string (e.g., "2 hours ago", "yesterday")
 * @param date - Date object or ISO string to format
 * @returns Formatted string like "2 hours ago" or falls back to formatDateTime for older dates
 */
export function formatRelativeTime(date: Date | string): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - dateObj.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) {
    return 'just now';
  } else if (diffMins < 60) {
    return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
  } else if (diffDays === 1) {
    return 'yesterday';
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    // For dates older than a week, show the full date
    return formatDate(dateObj);
  }
}

/**
 * Formats a timestamp to show both date and relative time
 * @param date - Date object or ISO string to format
 * @returns Formatted string like "Jan 15, 2024 (2 hours ago)"
 */
export function formatTimestamp(date: Date | string): string {
  const formattedDate = formatDate(date);
  const relativeTime = formatRelativeTime(date);
  
  // If relative time is the same as the formatted date (for old dates),
  // just return the formatted date
  if (relativeTime === formattedDate) {
    return formattedDate;
  }
  
  return `${formattedDate} (${relativeTime})`;
}
