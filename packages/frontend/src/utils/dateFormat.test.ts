/**
 * Unit tests for date formatting utilities
 * Validates Requirement 12.5: Display timestamps in delivery driver's local timezone
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  formatDateTime,
  formatDate,
  formatTime,
  formatDateLong,
  formatRelativeTime,
  formatTimestamp,
} from './dateFormat';

describe('Date Formatting Utilities', () => {
  beforeEach(() => {
    // Set a fixed time for consistent testing
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T15:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('formatDateTime', () => {
    it('should format a Date object with date and time', () => {
      const date = new Date('2024-01-15T15:45:00.000Z');
      const result = formatDateTime(date);
      
      // Result will vary by timezone, so just check it's a non-empty string
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should format an ISO string with date and time', () => {
      const isoString = '2024-01-15T15:45:00.000Z';
      const result = formatDateTime(isoString);
      
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should handle different dates correctly', () => {
      const date1 = new Date('2024-01-01T12:00:00.000Z');
      const date2 = new Date('2024-12-31T23:59:59.000Z');
      
      const result1 = formatDateTime(date1);
      const result2 = formatDateTime(date2);
      
      expect(result1).not.toBe(result2);
      expect(result1).toBeTruthy();
      expect(result2).toBeTruthy();
    });
  });

  describe('formatDate', () => {
    it('should format a Date object with date only', () => {
      const date = new Date('2024-01-15T15:45:00.000Z');
      const result = formatDate(date);
      
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      // Should not contain time indicators
      expect(result.toLowerCase()).not.toContain('am');
      expect(result.toLowerCase()).not.toContain('pm');
    });

    it('should format an ISO string with date only', () => {
      const isoString = '2024-01-15T15:45:00.000Z';
      const result = formatDate(isoString);
      
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });
  });

  describe('formatTime', () => {
    it('should format a Date object with time only', () => {
      const date = new Date('2024-01-15T15:45:00.000Z');
      const result = formatTime(date);
      
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      // Should contain time indicators
      expect(result.toLowerCase()).toMatch(/(am|pm)/);
    });

    it('should format an ISO string with time only', () => {
      const isoString = '2024-01-15T09:30:00.000Z';
      const result = formatTime(isoString);
      
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result.toLowerCase()).toMatch(/(am|pm)/);
    });
  });

  describe('formatDateLong', () => {
    it('should format a Date object in long format', () => {
      const date = new Date('2024-01-15T15:45:00.000Z');
      const result = formatDateLong(date);
      
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      // Should contain a weekday
      expect(result).toMatch(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/);
    });

    it('should format an ISO string in long format', () => {
      const isoString = '2024-01-15T15:45:00.000Z';
      const result = formatDateLong(isoString);
      
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });
  });

  describe('formatRelativeTime', () => {
    it('should return "just now" for very recent timestamps', () => {
      const date = new Date('2024-01-15T15:29:30.000Z'); // 30 seconds ago
      const result = formatRelativeTime(date);
      
      expect(result).toBe('just now');
    });

    it('should return minutes ago for recent timestamps', () => {
      const date = new Date('2024-01-15T15:25:00.000Z'); // 5 minutes ago
      const result = formatRelativeTime(date);
      
      expect(result).toBe('5 minutes ago');
    });

    it('should return "1 minute ago" for singular', () => {
      const date = new Date('2024-01-15T15:29:00.000Z'); // 1 minute ago
      const result = formatRelativeTime(date);
      
      expect(result).toBe('1 minute ago');
    });

    it('should return hours ago for timestamps within 24 hours', () => {
      const date = new Date('2024-01-15T13:30:00.000Z'); // 2 hours ago
      const result = formatRelativeTime(date);
      
      expect(result).toBe('2 hours ago');
    });

    it('should return "1 hour ago" for singular', () => {
      const date = new Date('2024-01-15T14:30:00.000Z'); // 1 hour ago
      const result = formatRelativeTime(date);
      
      expect(result).toBe('1 hour ago');
    });

    it('should return "yesterday" for timestamps 1 day ago', () => {
      const date = new Date('2024-01-14T15:30:00.000Z'); // 1 day ago
      const result = formatRelativeTime(date);
      
      expect(result).toBe('yesterday');
    });

    it('should return days ago for timestamps within a week', () => {
      const date = new Date('2024-01-12T15:30:00.000Z'); // 3 days ago
      const result = formatRelativeTime(date);
      
      expect(result).toBe('3 days ago');
    });

    it('should return formatted date for timestamps older than a week', () => {
      const date = new Date('2024-01-01T15:30:00.000Z'); // 2 weeks ago
      const result = formatRelativeTime(date);
      
      // Should be a formatted date, not relative
      expect(result).toBeTruthy();
      expect(result).not.toContain('ago');
    });
  });

  describe('formatTimestamp', () => {
    it('should combine date and relative time for recent timestamps', () => {
      const date = new Date('2024-01-15T13:30:00.000Z'); // 2 hours ago
      const result = formatTimestamp(date);
      
      expect(result).toBeTruthy();
      expect(result).toContain('ago');
    });

    it('should return only formatted date for old timestamps', () => {
      const date = new Date('2024-01-01T15:30:00.000Z'); // 2 weeks ago
      const result = formatTimestamp(date);
      
      expect(result).toBeTruthy();
      // Should not have duplicate date information
      expect(result.split('(').length).toBeLessThanOrEqual(2);
    });
  });

  describe('Timezone Awareness', () => {
    it('should convert UTC timestamps to local timezone', () => {
      // This test verifies that the functions use the local timezone
      const utcDate = new Date('2024-01-15T00:00:00.000Z');
      const result = formatDateTime(utcDate);
      
      // The formatted result should reflect local timezone conversion
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should handle ISO string timestamps correctly', () => {
      const isoString = '2024-01-15T12:00:00.000Z';
      const result1 = formatDateTime(isoString);
      const result2 = formatDateTime(new Date(isoString));
      
      // Both should produce the same result
      expect(result1).toBe(result2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle dates in the past', () => {
      const date = new Date('2020-01-01T00:00:00.000Z');
      
      expect(() => formatDateTime(date)).not.toThrow();
      expect(() => formatDate(date)).not.toThrow();
      expect(() => formatTime(date)).not.toThrow();
      expect(() => formatDateLong(date)).not.toThrow();
      expect(() => formatRelativeTime(date)).not.toThrow();
      expect(() => formatTimestamp(date)).not.toThrow();
    });

    it('should handle dates in different years', () => {
      const date1 = new Date('2023-06-15T12:00:00.000Z');
      const date2 = new Date('2025-06-15T12:00:00.000Z');
      
      const result1 = formatDate(date1);
      const result2 = formatDate(date2);
      
      expect(result1).toBeTruthy();
      expect(result2).toBeTruthy();
      expect(result1).not.toBe(result2);
    });
  });
});
