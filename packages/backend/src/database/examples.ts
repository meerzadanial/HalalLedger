/**
 * DatabaseClient Usage Examples
 * 
 * These examples demonstrate how to use the DatabaseClient in service classes.
 * DO NOT import this file in production code - it's for reference only.
 */

import { getDatabaseClient } from './index';

// Example 1: Delivery Entry Service with Transaction Management
export class DeliveryEntryServiceExample {
  /**
   * Creates a delivery entry with automatic validation
   * Uses transaction to ensure data consistency
   */
  async createDeliveryEntry(
    userId: string,
    restaurantName: string,
    restaurantStatus: 'halal' | 'non-halal',
    fareAmount: number,
    hasCashOrder: boolean,
    cashAmount?: number,
    entryDate?: Date
  ) {
    const dbClient = getDatabaseClient();

    return await dbClient.transaction(async (tx) => {
      // Check for duplicate entry
      const existingEntry = await tx.deliveryEntry.findFirst({
        where: {
          userId,
          restaurantName,
          fareAmount,
          entryDate: entryDate || new Date(),
        },
      });

      if (existingEntry) {
        throw new Error('Duplicate entry detected');
      }

      // Create the delivery entry
      const entry = await tx.deliveryEntry.create({
        data: {
          userId,
          restaurantName,
          restaurantStatus,
          fareAmount,
          hasCashOrder,
          cashAmount,
          entryDate: entryDate || new Date(),
        },
      });

      return entry;
    });
  }
}

// Example 2: Analytics Service with Raw SQL Queries
export class AnalyticsServiceExample {
  /**
   * Calculates monthly delivery totals using raw SQL for performance
   * Uses prepared statements for SQL injection prevention
   */
  async getMonthlyTotals(userId: string, year: number, month: number) {
    const dbClient = getDatabaseClient();

    const result = await dbClient.query<
      Array<{ restaurant_status: string; total: string; count: string }>
    >(
      `
      SELECT 
        restaurant_status,
        SUM(fare_amount) as total,
        COUNT(id) as count
      FROM delivery_entries
      WHERE 
        user_id = $1 
        AND EXTRACT(YEAR FROM entry_date) = $2
        AND EXTRACT(MONTH FROM entry_date) = $3
      GROUP BY restaurant_status
      ORDER BY restaurant_status
    `,
      [userId, year, month]
    );

    return result.map((row) => ({
      restaurantStatus: row.restaurant_status,
      total: parseFloat(row.total),
      count: parseInt(row.count, 10),
    }));
  }

  /**
   * Gets income trend data using parameterized query
   */
  async getIncomeTrend(userId: string, startDate: Date, endDate: Date) {
    const dbClient = getDatabaseClient();

    return await dbClient.query<
      Array<{ date: Date; daily_total: string }>
    >(
      `
      SELECT 
        entry_date as date,
        SUM(fare_amount + COALESCE(cash_amount, 0)) as daily_total
      FROM delivery_entries
      WHERE 
        user_id = $1
        AND entry_date >= $2
        AND entry_date <= $3
      GROUP BY entry_date
      ORDER BY entry_date ASC
    `,
      [userId, startDate, endDate]
    );
  }
}

// Example 3: Migration Service with Batch Operations
export class MigrationServiceExample {
  /**
   * Imports delivery entries in batches using transaction
   * Demonstrates retry logic and transaction management combined
   */
  async importDeliveryEntries(
    userId: string,
    entries: Array<{
      restaurantName: string;
      restaurantStatus: 'halal' | 'non-halal';
      fareAmount: number;
      hasCashOrder: boolean;
      cashAmount?: number;
      entryDate: Date;
    }>
  ) {
    const dbClient = getDatabaseClient();
    const batchSize = 100;
    const imported: string[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    // Process in batches
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);

      try {
        // Use retry logic for the entire batch
        await dbClient.executeWithRetry(async () => {
          // Use transaction for atomic batch insert
          await dbClient.transaction(async (tx) => {
            for (const entry of batch) {
              const created = await tx.deliveryEntry.create({
                data: {
                  userId,
                  restaurantName: entry.restaurantName,
                  restaurantStatus: entry.restaurantStatus,
                  fareAmount: entry.fareAmount,
                  hasCashOrder: entry.hasCashOrder,
                  cashAmount: entry.cashAmount,
                  entryDate: entry.entryDate,
                },
              });
              imported.push(created.id);
            }
          });
        });
      } catch (error) {
        // Log batch errors
        batch.forEach((_, index) => {
          errors.push({
            index: i + index,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        });
      }
    }

    return {
      imported: imported.length,
      errors,
    };
  }
}

// Example 4: Health Check Endpoint
export async function healthCheckExample() {
  const dbClient = getDatabaseClient();
  
  const isHealthy = await dbClient.healthCheck();
  
  return {
    database: {
      status: isHealthy ? 'healthy' : 'unhealthy',
      pool: dbClient.getPoolInfo(),
    },
  };
}

// Example 5: Graceful Shutdown Handler
export function setupGracefulShutdown(server: any) {
  const shutdown = async (signal: string) => {
    console.log(`${signal} received: closing server gracefully`);
    
    server.close(async () => {
      console.log('HTTP server closed');
      
      try {
        const { closeDatabase } = await import('./index');
        await closeDatabase();
        console.log('Database connections closed');
        process.exit(0);
      } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
