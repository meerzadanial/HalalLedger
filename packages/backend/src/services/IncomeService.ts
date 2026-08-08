import { getDatabaseClient } from "../database";
import { DeliveryEntry, DeliveryEntryFormData } from "../types";

/**
 * IncomeService - Handles business logic for delivery entries and income tracking
 * 
 * Features:
 * - CRUD operations for delivery entries
 * - Automatic income segregation (halal/non-halal)
 * - Duplicate detection
 * - Restaurant name autocomplete
 * - Filtering and aggregation
 * 
 * Validates Requirements: 2.7, 3.1, 3.2, 3.3, 5.3, 5.4, 8.1-8.7
 */
export class IncomeService {
  /**
   * Gets autocomplete suggestions for restaurant names
   * Returns up to 10 matching restaurant names from the user's previous entries
   * 
   * @param userId - User ID to filter restaurant names
   * @param searchQuery - Search query to match restaurant names (case-insensitive)
   * @returns Array of up to 10 matching restaurant names
   * 
   * Validates Requirements: 5.3, 5.4
   */
  async getRestaurantNameSuggestions(
    userId: string,
    searchQuery: string
  ): Promise<string[]> {
    const dbClient = getDatabaseClient();

    return await dbClient.executeWithRetry(async () => {
      const prisma = dbClient.getClient();

      // Query distinct restaurant names that match the search query
      // Use case-insensitive ILIKE for partial matching
      const results = await prisma.$queryRaw<
        Array<{ restaurant_name: string }>
      >`
        SELECT DISTINCT restaurant_name
        FROM delivery_entries
        WHERE user_id = ${userId}
        AND restaurant_name ILIKE ${`%${searchQuery}%`}
        ORDER BY restaurant_name ASC
        LIMIT 10
      `;

      return results.map((row) => row.restaurant_name);
    });
  }

  /**
   * Creates a new delivery entry
   * 
   * @param userId - User ID
   * @param data - Delivery entry form data
   * @returns Created delivery entry
   * 
   * Validates Requirements: 2.7, 7.1
   */
  async createEntry(
    userId: string,
    data: DeliveryEntryFormData
  ): Promise<DeliveryEntry> {
    const dbClient = getDatabaseClient();

    return await dbClient.transaction(async (tx) => {
      // Create the delivery entry
      const entry = await tx.deliveryEntry.create({
        data: {
          userId,
          restaurantName: data.restaurantName,
          restaurantStatus: data.restaurantStatus,
          fareAmount: data.fareAmount,
          hasCashOrder: data.hasCashOrder,
          cashAmount: data.cashAmount,
          entryDate: data.entryDate || new Date(),
          timestamp: new Date(),
        },
      });

      // Map to DeliveryEntry interface
      return {
        id: entry.id,
        userId: entry.userId,
        restaurantName: entry.restaurantName,
        restaurantStatus: entry.restaurantStatus as "halal" | "non-halal",
        fareAmount: Number(entry.fareAmount),
        hasCashOrder: entry.hasCashOrder,
        cashAmount: entry.cashAmount ? Number(entry.cashAmount) : undefined,
        entryDate: entry.entryDate,
        timestamp: entry.timestamp,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      };
    });
  }

  /**
   * Updates an existing delivery entry
   * 
   * @param userId - User ID (for ownership validation)
   * @param entryId - Entry ID to update
   * @param data - Partial delivery entry data to update
   * @returns Updated delivery entry
   * 
   * Validates Requirements: 14.1, 14.2
   */
  async updateEntry(
    userId: string,
    entryId: string,
    data: Partial<DeliveryEntryFormData>
  ): Promise<DeliveryEntry> {
    const dbClient = getDatabaseClient();

    return await dbClient.transaction(async (tx) => {
      // Verify ownership
      const existingEntry = await tx.deliveryEntry.findFirst({
        where: { id: entryId, userId },
      });

      if (!existingEntry) {
        throw new Error("Entry not found or does not belong to user");
      }

      // Update the entry
      const entry = await tx.deliveryEntry.update({
        where: { id: entryId },
        data: {
          ...(data.restaurantName && { restaurantName: data.restaurantName }),
          ...(data.restaurantStatus && {
            restaurantStatus: data.restaurantStatus,
          }),
          ...(data.fareAmount !== undefined && { fareAmount: data.fareAmount }),
          ...(data.hasCashOrder !== undefined && {
            hasCashOrder: data.hasCashOrder,
          }),
          ...(data.cashAmount !== undefined && { cashAmount: data.cashAmount }),
          ...(data.entryDate && { entryDate: data.entryDate }),
        },
      });

      return {
        id: entry.id,
        userId: entry.userId,
        restaurantName: entry.restaurantName,
        restaurantStatus: entry.restaurantStatus as "halal" | "non-halal",
        fareAmount: Number(entry.fareAmount),
        hasCashOrder: entry.hasCashOrder,
        cashAmount: entry.cashAmount ? Number(entry.cashAmount) : undefined,
        entryDate: entry.entryDate,
        timestamp: entry.timestamp,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      };
    });
  }

  /**
   * Deletes a delivery entry
   * 
   * @param userId - User ID (for ownership validation)
   * @param entryId - Entry ID to delete
   * 
   * Validates Requirements: 14.3, 14.4
   */
  async deleteEntry(userId: string, entryId: string): Promise<void> {
    const dbClient = getDatabaseClient();

    await dbClient.transaction(async (tx) => {
      // Verify ownership
      const existingEntry = await tx.deliveryEntry.findFirst({
        where: { id: entryId, userId },
      });

      if (!existingEntry) {
        throw new Error("Entry not found or does not belong to user");
      }

      // Delete the entry
      await tx.deliveryEntry.delete({
        where: { id: entryId },
      });
    });
  }

  /**
   * Gets a single delivery entry by ID
   * 
   * @param userId - User ID (for ownership validation)
   * @param entryId - Entry ID to retrieve
   * @returns Delivery entry or null if not found
   * 
   * Validates Requirements: 14.1
   */
  async getEntryById(userId: string, entryId: string): Promise<DeliveryEntry | null> {
    const dbClient = getDatabaseClient();

    const entry = await dbClient.getClient().deliveryEntry.findFirst({
      where: {
        id: entryId,
        userId,
      },
    });

    if (!entry) {
      return null;
    }

    // Map to DeliveryEntry interface
    return {
      id: entry.id,
      userId: entry.userId,
      restaurantName: entry.restaurantName,
      restaurantStatus: entry.restaurantStatus as "halal" | "non-halal",
      fareAmount: Number(entry.fareAmount),
      hasCashOrder: entry.hasCashOrder,
      cashAmount: entry.cashAmount ? Number(entry.cashAmount) : undefined,
      entryDate: entry.entryDate,
      timestamp: entry.timestamp,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  /**
   * Gets delivery entries with optional filtering
   * Returns entries in reverse chronological order
   * 
   * @param userId - User ID
   * @param filters - Optional filters (date range, status, payment type)
   * @returns Array of delivery entries
   * 
   * Validates Requirements: 8.1, 8.2, 8.3, 8.4
   */
  async getEntries(
    userId: string,
    filters?: {
      startDate?: Date;
      endDate?: Date;
      restaurantStatus?: "halal" | "non-halal";
      paymentType?: "cash" | "digital" | "both";
      limit?: number;
      offset?: number;
    }
  ): Promise<{ entries: DeliveryEntry[]; total: number }> {
    const dbClient = getDatabaseClient();

    return await dbClient.executeWithRetry(async () => {
      const prisma = dbClient.getClient();

      // Build where clause
      const where: any = { userId };

      if (filters?.startDate || filters?.endDate) {
        where.entryDate = {};
        if (filters.startDate) {
          where.entryDate.gte = filters.startDate;
        }
        if (filters.endDate) {
          where.entryDate.lte = filters.endDate;
        }
      }

      if (filters?.restaurantStatus) {
        where.restaurantStatus = filters.restaurantStatus;
      }

      if (filters?.paymentType === "cash") {
        where.hasCashOrder = true;
      } else if (filters?.paymentType === "digital") {
        where.hasCashOrder = false;
      }

      // Get total count
      const total = await prisma.deliveryEntry.count({ where });

      // Get entries with pagination
      const entries = await prisma.deliveryEntry.findMany({
        where,
        orderBy: { entryDate: "desc" },
        take: filters?.limit,
        skip: filters?.offset,
      });

      return {
        entries: entries.map((entry) => ({
          id: entry.id,
          userId: entry.userId,
          restaurantName: entry.restaurantName,
          restaurantStatus: entry.restaurantStatus as "halal" | "non-halal",
          fareAmount: Number(entry.fareAmount),
          hasCashOrder: entry.hasCashOrder,
          cashAmount: entry.cashAmount ? Number(entry.cashAmount) : undefined,
          entryDate: entry.entryDate,
          timestamp: entry.timestamp,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        })),
        total,
      };
    });
  }

  /**
   * Calculates income totals with optional filtering
   * 
   * @param userId - User ID
   * @param filters - Optional filters (date range, status)
   * @returns Income totals breakdown
   * 
   * Validates Requirements: 3.4, 3.5, 4.4, 4.5, 8.5, 8.6, 8.7
   */
  async calculateTotals(
    userId: string,
    filters?: {
      startDate?: Date;
      endDate?: Date;
      restaurantStatus?: "halal" | "non-halal";
    }
  ): Promise<{
    totalHalalIncome: number;
    totalNonHalalIncome: number;
    totalCashIncome: number;
    totalDigitalIncome: number;
  }> {
    const dbClient = getDatabaseClient();

    return await dbClient.executeWithRetry(async () => {
      const prisma = dbClient.getClient();

      // Build where clause
      const where: any = { userId };

      if (filters?.startDate || filters?.endDate) {
        where.entryDate = {};
        if (filters.startDate) {
          where.entryDate.gte = filters.startDate;
        }
        if (filters.endDate) {
          where.entryDate.lte = filters.endDate;
        }
      }

      if (filters?.restaurantStatus) {
        where.restaurantStatus = filters.restaurantStatus;
      }

      // Get all entries matching the filter
      const entries = await prisma.deliveryEntry.findMany({ where });

      // Calculate totals
      let totalHalalIncome = 0;
      let totalNonHalalIncome = 0;
      let totalCashIncome = 0;
      let totalDigitalIncome = 0;

      for (const entry of entries) {
        const fareAmount = Number(entry.fareAmount);
        const cashAmount = entry.cashAmount ? Number(entry.cashAmount) : 0;
        const totalAmount = fareAmount + cashAmount;

        // Segregate by restaurant status
        if (entry.restaurantStatus === "halal") {
          totalHalalIncome += totalAmount;
        } else {
          totalNonHalalIncome += totalAmount;
        }

        // Segregate by payment type
        totalDigitalIncome += fareAmount;
        if (entry.hasCashOrder && cashAmount > 0) {
          totalCashIncome += cashAmount;
        }
      }

      return {
        totalHalalIncome,
        totalNonHalalIncome,
        totalCashIncome,
        totalDigitalIncome,
      };
    });
  }

  /**
   * Checks for potential duplicate entries
   * Matches on: date, restaurant name (case-insensitive), fare amount, and cash amount
   * 
   * @param userId - User ID
   * @param data - Delivery entry data to check
   * @returns true if a potential duplicate exists
   * 
   * Validates Requirements: implicit from design duplicate detection
   */
  async checkDuplicate(
    userId: string,
    data: DeliveryEntryFormData
  ): Promise<boolean> {
    const dbClient = getDatabaseClient();

    return await dbClient.executeWithRetry(async () => {
      const prisma = dbClient.getClient();

      // Use the entry date or default to today
      const entryDate = data.entryDate || new Date();
      // Normalize to start of day for date comparison
      const normalizedDate = new Date(entryDate);
      normalizedDate.setHours(0, 0, 0, 0);
      const endOfDay = new Date(normalizedDate);
      endOfDay.setHours(23, 59, 59, 999);

      // Build query conditions for duplicate detection
      // Match on: date, restaurant name (case-insensitive), fare amount, and cash details
      const whereConditions: any = {
        userId: userId,
        entryDate: {
          gte: normalizedDate,
          lte: endOfDay,
        },
        fareAmount: data.fareAmount,
        hasCashOrder: data.hasCashOrder,
      };

      // If there's a cash order, also match on cash amount
      if (data.hasCashOrder && data.cashAmount !== undefined) {
        whereConditions.cashAmount = data.cashAmount;
      }

      // Use raw SQL for case-insensitive restaurant name comparison
      const duplicates = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM delivery_entries
        WHERE user_id = ${userId}::uuid
          AND entry_date >= ${normalizedDate}::date
          AND entry_date <= ${endOfDay}::date
          AND LOWER(restaurant_name) = LOWER(${data.restaurantName})
          AND fare_amount = ${data.fareAmount}::decimal
          AND has_cash_order = ${data.hasCashOrder}
          AND (
            ${!data.hasCashOrder} 
            OR (has_cash_order = true AND cash_amount = ${data.cashAmount || null}::decimal)
          )
        LIMIT 1
      `;

      return duplicates.length > 0;
    });
  }
}
