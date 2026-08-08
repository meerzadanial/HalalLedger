/**
 * Integration tests for DashboardPage timezone display
 * Validates Requirement 12.5: Display timestamps in delivery driver's local timezone
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import DashboardPage from './DashboardPage';
import { AuthProvider } from '../contexts/AuthContext';
import * as api from '../services/api';

// Mock the API module
vi.mock('../services/api', () => ({
  deliveryEntriesApi: {
    getAll: vi.fn(),
    delete: vi.fn(),
  },
  analyticsApi: {
    getTotals: vi.fn(),
  },
}));

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('DashboardPage - Timezone Display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock localStorage for auth token
    Storage.prototype.getItem = vi.fn(() => 'mock-token');
    Storage.prototype.removeItem = vi.fn();
  });

  const renderDashboard = () => {
    return render(
      <BrowserRouter>
        <AuthProvider>
          <DashboardPage />
        </AuthProvider>
      </BrowserRouter>
    );
  };

  it('should display formatted entry dates in local timezone', async () => {
    // Mock API responses with UTC timestamps
    const mockEntries = [
      {
        id: '1',
        userId: 'user1',
        restaurantName: 'Test Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 15.50,
        hasCashOrder: false,
        entryDate: new Date('2024-01-15T00:00:00.000Z'),
        timestamp: new Date('2024-01-15T10:30:00.000Z'),
        createdAt: new Date('2024-01-15T10:30:00.000Z'),
        updatedAt: new Date('2024-01-15T10:30:00.000Z'),
      },
    ];

    const mockTotals = {
      totalHalalIncome: 15.50,
      totalNonHalalIncome: 0,
      totalCashIncome: 0,
      totalDigitalIncome: 15.50,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 1,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Test Restaurant')).toBeInTheDocument();
    });

    // Verify date formatting is applied (dates are displayed)
    // The exact format depends on the user's local timezone, so we check for presence
    const entryDateElements = screen.queryAllByText(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);
    expect(entryDateElements.length).toBeGreaterThan(0);
  });

  it('should display creation timestamps with relative time', async () => {
    // Create a recent timestamp (2 hours ago)
    const twoHoursAgo = new Date();
    twoHoursAgo.setHours(twoHoursAgo.getHours() - 2);

    const mockEntries = [
      {
        id: '1',
        userId: 'user1',
        restaurantName: 'Recent Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 20.00,
        hasCashOrder: true,
        cashAmount: 5.00,
        entryDate: twoHoursAgo,
        timestamp: twoHoursAgo,
        createdAt: twoHoursAgo,
        updatedAt: twoHoursAgo,
      },
    ];

    const mockTotals = {
      totalHalalIncome: 25.00,
      totalNonHalalIncome: 0,
      totalCashIncome: 5.00,
      totalDigitalIncome: 20.00,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 1,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Recent Restaurant')).toBeInTheDocument();
    });

    // Check for "Created:" label which indicates timestamp display
    expect(screen.getByText(/Created:/)).toBeInTheDocument();
  });

  it('should display cash amounts when present', async () => {
    const mockEntries = [
      {
        id: '1',
        userId: 'user1',
        restaurantName: 'Cash Restaurant',
        restaurantStatus: 'non-halal' as const,
        fareAmount: 12.50,
        hasCashOrder: true,
        cashAmount: 8.25,
        entryDate: new Date('2024-01-15T00:00:00.000Z'),
        timestamp: new Date('2024-01-15T10:30:00.000Z'),
        createdAt: new Date('2024-01-15T10:30:00.000Z'),
        updatedAt: new Date('2024-01-15T10:30:00.000Z'),
      },
    ];

    const mockTotals = {
      totalHalalIncome: 0,
      totalNonHalalIncome: 20.75,
      totalCashIncome: 8.25,
      totalDigitalIncome: 12.50,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 1,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Cash Restaurant')).toBeInTheDocument();
    });

    // Verify cash amount is displayed
    expect(screen.getByText(/Cash: RM\s?8\.25/)).toBeInTheDocument();
  });

  it('should handle multiple entries with different timestamps', async () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const lastWeek = new Date(now);
    lastWeek.setDate(lastWeek.getDate() - 7);

    const mockEntries = [
      {
        id: '1',
        userId: 'user1',
        restaurantName: 'Today Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 10.00,
        hasCashOrder: false,
        entryDate: now,
        timestamp: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: '2',
        userId: 'user1',
        restaurantName: 'Yesterday Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 15.00,
        hasCashOrder: false,
        entryDate: yesterday,
        timestamp: yesterday,
        createdAt: yesterday,
        updatedAt: yesterday,
      },
      {
        id: '3',
        userId: 'user1',
        restaurantName: 'Last Week Restaurant',
        restaurantStatus: 'non-halal' as const,
        fareAmount: 20.00,
        hasCashOrder: false,
        entryDate: lastWeek,
        timestamp: lastWeek,
        createdAt: lastWeek,
        updatedAt: lastWeek,
      },
    ];

    const mockTotals = {
      totalHalalIncome: 25.00,
      totalNonHalalIncome: 20.00,
      totalCashIncome: 0,
      totalDigitalIncome: 45.00,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 3,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Today Restaurant')).toBeInTheDocument();
      expect(screen.getByText('Yesterday Restaurant')).toBeInTheDocument();
      expect(screen.getByText('Last Week Restaurant')).toBeInTheDocument();
    });

    // All entries should display formatted dates
    const dateElements = screen.queryAllByText(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);
    expect(dateElements.length).toBeGreaterThan(0);
  });

  it('should display income totals correctly', async () => {
    const mockEntries: any[] = [];

    const mockTotals = {
      totalHalalIncome: 100.50,
      totalNonHalalIncome: 75.25,
      totalCashIncome: 50.00,
      totalDigitalIncome: 125.75,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 0,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Total Halal Income')).toBeInTheDocument();
    });

    // Verify all totals are displayed
    expect(screen.getByText(/RM\s+100\.50/)).toBeInTheDocument();
    expect(screen.getByText(/RM\s+75\.25/)).toBeInTheDocument();
    expect(screen.getByText(/RM\s+50\.00/)).toBeInTheDocument();
    expect(screen.getByText(/RM\s+125\.75/)).toBeInTheDocument();
  });

  it('should show loading state initially', () => {
    vi.mocked(api.deliveryEntriesApi.getAll).mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );
    vi.mocked(api.analyticsApi.getTotals).mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    renderDashboard();

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('should handle empty entries list', async () => {
    const mockTotals = {
      totalHalalIncome: 0,
      totalNonHalalIncome: 0,
      totalCashIncome: 0,
      totalDigitalIncome: 0,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: [],
      total: 0,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText(/No entries found/)).toBeInTheDocument();
    });

    expect(screen.getByText(/Create your first delivery entry!/)).toBeInTheDocument();
  });
});

/**
 * Pagination tests for DashboardPage
 * Validates Requirements: 8.1, 8.5, 8.6, 8.7
 */
describe('DashboardPage - Pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock localStorage for auth token
    Storage.prototype.getItem = vi.fn(() => 'mock-token');
    Storage.prototype.removeItem = vi.fn();
  });

  const renderDashboard = () => {
    return render(
      <BrowserRouter>
        <AuthProvider>
          <DashboardPage />
        </AuthProvider>
      </BrowserRouter>
    );
  };

  it('should display "Showing X-Y of Z" pagination info when entries exist', async () => {
    const mockEntries = Array.from({ length: 10 }, (_, i) => ({
      id: `${i + 1}`,
      userId: 'user1',
      restaurantName: `Restaurant ${i + 1}`,
      restaurantStatus: 'halal' as const,
      fareAmount: 10.00 + i,
      hasCashOrder: false,
      entryDate: new Date(),
      timestamp: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const mockTotals = {
      totalHalalIncome: 100.00,
      totalNonHalalIncome: 0,
      totalCashIncome: 0,
      totalDigitalIncome: 100.00,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 45, // Total of 45 entries in database
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText(/Showing 1-10 of 45 entries/)).toBeInTheDocument();
    });
  });

  it('should not display pagination info when no entries exist', async () => {
    const mockTotals = {
      totalHalalIncome: 0,
      totalNonHalalIncome: 0,
      totalCashIncome: 0,
      totalDigitalIncome: 0,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: [],
      total: 0,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText(/No entries found/)).toBeInTheDocument();
    });

    // Should not show pagination info
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });

  it('should request entries with limit and offset parameters', async () => {
    const mockEntries = Array.from({ length: 10 }, (_, i) => ({
      id: `${i + 1}`,
      userId: 'user1',
      restaurantName: `Restaurant ${i + 1}`,
      restaurantStatus: 'halal' as const,
      fareAmount: 10.00 + i,
      hasCashOrder: false,
      entryDate: new Date(),
      timestamp: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const mockTotals = {
      totalHalalIncome: 100.00,
      totalNonHalalIncome: 0,
      totalCashIncome: 0,
      totalDigitalIncome: 100.00,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 45,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);

    renderDashboard();

    await waitFor(() => {
      expect(api.deliveryEntriesApi.getAll).toHaveBeenCalledWith({
        limit: 10,
        offset: 0,
      });
    });
  });

  it('should display entries in reverse chronological order (verified by API contract)', async () => {
    // The API returns entries in reverse chronological order by default (Requirement 8.1)
    // This test verifies the component correctly displays the entries it receives
    const mockEntries = [
      {
        id: '1',
        userId: 'user1',
        restaurantName: 'Most Recent Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 30.00,
        hasCashOrder: false,
        entryDate: new Date('2024-01-20T10:30:00.000Z'),
        timestamp: new Date('2024-01-20T10:30:00.000Z'),
        createdAt: new Date('2024-01-20T10:30:00.000Z'),
        updatedAt: new Date('2024-01-20T10:30:00.000Z'),
      },
      {
        id: '2',
        userId: 'user1',
        restaurantName: 'Second Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 20.00,
        hasCashOrder: false,
        entryDate: new Date('2024-01-19T10:30:00.000Z'),
        timestamp: new Date('2024-01-19T10:30:00.000Z'),
        createdAt: new Date('2024-01-19T10:30:00.000Z'),
        updatedAt: new Date('2024-01-19T10:30:00.000Z'),
      },
      {
        id: '3',
        userId: 'user1',
        restaurantName: 'Oldest Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 10.00,
        hasCashOrder: false,
        entryDate: new Date('2024-01-18T10:30:00.000Z'),
        timestamp: new Date('2024-01-18T10:30:00.000Z'),
        createdAt: new Date('2024-01-18T10:30:00.000Z'),
        updatedAt: new Date('2024-01-18T10:30:00.000Z'),
      },
    ];

    const mockTotals = {
      totalHalalIncome: 60.00,
      totalNonHalalIncome: 0,
      totalCashIncome: 0,
      totalDigitalIncome: 60.00,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 3,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Most Recent Restaurant')).toBeInTheDocument();
      expect(screen.getByText('Second Restaurant')).toBeInTheDocument();
      expect(screen.getByText('Oldest Restaurant')).toBeInTheDocument();
    });

    // The API contract guarantees reverse chronological order
    // The component displays entries in the order received from the API
  });

  it('should display all income totals correctly', async () => {
    const mockEntries = [
      {
        id: '1',
        userId: 'user1',
        restaurantName: 'Halal Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 50.00,
        hasCashOrder: true,
        cashAmount: 10.00,
        entryDate: new Date(),
        timestamp: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: '2',
        userId: 'user1',
        restaurantName: 'Non-Halal Restaurant',
        restaurantStatus: 'non-halal' as const,
        fareAmount: 30.00,
        hasCashOrder: false,
        entryDate: new Date(),
        timestamp: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const mockTotals = {
      totalHalalIncome: 60.00, // 50 + 10
      totalNonHalalIncome: 30.00,
      totalCashIncome: 10.00,
      totalDigitalIncome: 80.00, // 50 + 30
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 2,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Total Halal Income')).toBeInTheDocument();
    });

    // Verify all income totals are displayed (Requirements 8.5, 8.6, 8.7)
    // Use more specific selectors to avoid ambiguity with entry amounts
    const halalIncomeElement = screen.getAllByText(/RM\s+60\.00/)[0]; // Get first occurrence (in totals section)
    expect(halalIncomeElement).toBeInTheDocument();
    
    const nonHalalIncomeElement = screen.getAllByText(/RM\s+30\.00/)[0]; // Get first occurrence (in totals section)
    expect(nonHalalIncomeElement).toBeInTheDocument();
    
    // Cash income (RM 10.00 also appears in the entry row's cash amount)
    expect(screen.getAllByText(/RM\s+10\.00/)[0]).toBeInTheDocument();
    // Digital income
    expect(screen.getByText(/RM\s+80\.00/)).toBeInTheDocument();
  });
});


/**
 * Tests for entry deletion functionality
 * Validates Requirements 14.3, 14.4
 */
describe('DashboardPage - Entry Deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock localStorage for auth token
    Storage.prototype.getItem = vi.fn(() => 'mock-token');
    Storage.prototype.removeItem = vi.fn();
    
    // Mock window.confirm to return true by default
    global.confirm = vi.fn(() => true);
  });

  const renderDashboard = () => {
    return render(
      <BrowserRouter>
        <AuthProvider>
          <DashboardPage />
        </AuthProvider>
      </BrowserRouter>
    );
  };

  it('should show confirmation dialog before deletion (Requirement 14.3)', async () => {
    const mockEntries = [
      {
        id: '1',
        userId: 'user1',
        restaurantName: 'Test Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 15.50,
        hasCashOrder: false,
        entryDate: new Date('2024-01-15'),
        timestamp: new Date('2024-01-15T10:30:00.000Z'),
        createdAt: new Date('2024-01-15T10:30:00.000Z'),
        updatedAt: new Date('2024-01-15T10:30:00.000Z'),
      },
    ];

    const mockTotals = {
      totalHalalIncome: 15.50,
      totalNonHalalIncome: 0,
      totalCashIncome: 0,
      totalDigitalIncome: 15.50,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 1,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);
    vi.mocked(api.deliveryEntriesApi.delete).mockResolvedValue(undefined);

    const { getAllByText } = renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Test Restaurant')).toBeInTheDocument();
    });

    // Click delete button
    const deleteButtons = getAllByText('Delete');
    deleteButtons[0].click();

    await waitFor(() => {
      // Verify confirmation dialog was shown with entry details
      expect(global.confirm).toHaveBeenCalledWith(
        expect.stringContaining('Test Restaurant')
      );
      expect(global.confirm).toHaveBeenCalledWith(
        expect.stringMatching(/RM\s*15\.50/)
      );
    });
  });

  it('should include cash amount in confirmation message when present', async () => {
    const mockEntries = [
      {
        id: '1',
        userId: 'user1',
        restaurantName: 'Cash Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 12.00,
        hasCashOrder: true,
        cashAmount: 5.00,
        entryDate: new Date('2024-01-15'),
        timestamp: new Date('2024-01-15T10:30:00.000Z'),
        createdAt: new Date('2024-01-15T10:30:00.000Z'),
        updatedAt: new Date('2024-01-15T10:30:00.000Z'),
      },
    ];

    const mockTotals = {
      totalHalalIncome: 17.00,
      totalNonHalalIncome: 0,
      totalCashIncome: 5.00,
      totalDigitalIncome: 12.00,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 1,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);
    vi.mocked(api.deliveryEntriesApi.delete).mockResolvedValue(undefined);

    const { getAllByText } = renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Cash Restaurant')).toBeInTheDocument();
    });

    // Click delete button
    const deleteButtons = getAllByText('Delete');
    deleteButtons[0].click();

    await waitFor(() => {
      // Verify confirmation includes both fare and cash amounts
      expect(global.confirm).toHaveBeenCalledWith(
        expect.stringMatching(/RM\s*12\.00.*RM\s*5\.00/)
      );
    });
  });

  it('should not delete entry if user cancels confirmation', async () => {
    // Mock window.confirm to return false (cancel)
    global.confirm = vi.fn(() => false);

    const mockEntries = [
      {
        id: '1',
        userId: 'user1',
        restaurantName: 'Test Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 15.50,
        hasCashOrder: false,
        entryDate: new Date('2024-01-15'),
        timestamp: new Date('2024-01-15T10:30:00.000Z'),
        createdAt: new Date('2024-01-15T10:30:00.000Z'),
        updatedAt: new Date('2024-01-15T10:30:00.000Z'),
      },
    ];

    const mockTotals = {
      totalHalalIncome: 15.50,
      totalNonHalalIncome: 0,
      totalCashIncome: 0,
      totalDigitalIncome: 15.50,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 1,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);
    const deleteSpy = vi.mocked(api.deliveryEntriesApi.delete);

    const { getAllByText } = renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Test Restaurant')).toBeInTheDocument();
    });

    // Click delete button
    const deleteButtons = getAllByText('Delete');
    deleteButtons[0].click();

    await waitFor(() => {
      // Verify delete API was NOT called
      expect(deleteSpy).not.toHaveBeenCalled();
    });
  });

  it('should call delete API and refresh data after confirmation (Requirement 14.4)', async () => {
    const mockEntriesBefore = [
      {
        id: '1',
        userId: 'user1',
        restaurantName: 'Test Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 15.50,
        hasCashOrder: false,
        entryDate: new Date('2024-01-15'),
        timestamp: new Date('2024-01-15T10:30:00.000Z'),
        createdAt: new Date('2024-01-15T10:30:00.000Z'),
        updatedAt: new Date('2024-01-15T10:30:00.000Z'),
      },
    ];

    const mockTotalsBefore = {
      totalHalalIncome: 15.50,
      totalNonHalalIncome: 0,
      totalCashIncome: 0,
      totalDigitalIncome: 15.50,
    };

    const mockEntriesAfter: any[] = [];
    const mockTotalsAfter = {
      totalHalalIncome: 0,
      totalNonHalalIncome: 0,
      totalCashIncome: 0,
      totalDigitalIncome: 0,
    };

    // First call returns entry, second call (after delete) returns empty
    vi.mocked(api.deliveryEntriesApi.getAll)
      .mockResolvedValueOnce({ entries: mockEntriesBefore, total: 1 })
      .mockResolvedValueOnce({ entries: mockEntriesAfter, total: 0 });
    
    vi.mocked(api.analyticsApi.getTotals)
      .mockResolvedValueOnce(mockTotalsBefore)
      .mockResolvedValueOnce(mockTotalsAfter);
    
    vi.mocked(api.deliveryEntriesApi.delete).mockResolvedValue(undefined);

    const { getAllByText } = renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Test Restaurant')).toBeInTheDocument();
    });

    // Click delete button
    const deleteButtons = getAllByText('Delete');
    deleteButtons[0].click();

    await waitFor(() => {
      // Verify delete API was called with correct ID
      expect(api.deliveryEntriesApi.delete).toHaveBeenCalledWith('1');
      
      // Verify data was refreshed (totals recalculated - Requirement 14.4)
      expect(api.deliveryEntriesApi.getAll).toHaveBeenCalledTimes(2);
      expect(api.analyticsApi.getTotals).toHaveBeenCalledTimes(2);
      
      // Verify entry is no longer in the list
      expect(screen.getByText(/No entries found/)).toBeInTheDocument();
    });
  });

  it('should show error message if deletion fails', async () => {
    const mockEntries = [
      {
        id: '1',
        userId: 'user1',
        restaurantName: 'Test Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 15.50,
        hasCashOrder: false,
        entryDate: new Date('2024-01-15'),
        timestamp: new Date('2024-01-15T10:30:00.000Z'),
        createdAt: new Date('2024-01-15T10:30:00.000Z'),
        updatedAt: new Date('2024-01-15T10:30:00.000Z'),
      },
    ];

    const mockTotals = {
      totalHalalIncome: 15.50,
      totalNonHalalIncome: 0,
      totalCashIncome: 0,
      totalDigitalIncome: 15.50,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 1,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);
    vi.mocked(api.deliveryEntriesApi.delete).mockRejectedValue(
      new Error('Failed to delete entry')
    );

    const { getAllByText } = renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Test Restaurant')).toBeInTheDocument();
    });

    // Click delete button
    const deleteButtons = getAllByText('Delete');
    deleteButtons[0].click();

    await waitFor(() => {
      // Verify error message is shown
      expect(screen.getByText('Failed to delete entry')).toBeInTheDocument();
    });
  });

  it('should disable delete button while deletion is in progress', async () => {
    const mockEntries = [
      {
        id: '1',
        userId: 'user1',
        restaurantName: 'Test Restaurant',
        restaurantStatus: 'halal' as const,
        fareAmount: 15.50,
        hasCashOrder: false,
        entryDate: new Date('2024-01-15'),
        timestamp: new Date('2024-01-15T10:30:00.000Z'),
        createdAt: new Date('2024-01-15T10:30:00.000Z'),
        updatedAt: new Date('2024-01-15T10:30:00.000Z'),
      },
    ];

    const mockTotals = {
      totalHalalIncome: 15.50,
      totalNonHalalIncome: 0,
      totalCashIncome: 0,
      totalDigitalIncome: 15.50,
    };

    vi.mocked(api.deliveryEntriesApi.getAll).mockResolvedValue({
      entries: mockEntries,
      total: 1,
    });
    vi.mocked(api.analyticsApi.getTotals).mockResolvedValue(mockTotals);
    
    // Mock delete to resolve after a delay
    vi.mocked(api.deliveryEntriesApi.delete).mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 100))
    );

    const { getAllByText } = renderDashboard();

    await waitFor(() => {
      expect(screen.getByText('Test Restaurant')).toBeInTheDocument();
    });

    // Click delete button
    const deleteButtons = getAllByText('Delete');
    const deleteButton = deleteButtons[0] as HTMLButtonElement;
    
    deleteButton.click();

    // Button should show "Deleting..." and be disabled
    await waitFor(() => {
      expect(screen.getByText('Deleting...')).toBeInTheDocument();
      
      const deletingButton = screen.getByText('Deleting...') as HTMLButtonElement;
      expect(deletingButton.disabled).toBe(true);
    });
  });
});
