import { PrismaClient } from '@prisma/client';

/**
 * Database Client Singleton
 * 
 * Manages PostgreSQL connection through Prisma ORM with:
 * - Connection pooling (configured via DATABASE_URL)
 * - Prepared statements for SQL injection prevention
 * - Type-safe queries
 * 
 * Validates Requirements:
 * - 7.8: Database persistence with connection pooling
 * - 11.1: Encrypted connection strings
 * - 11.2: SQL injection prevention via parameterized queries
 */

// Prevent multiple instances in development (hot reload)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Connect to database with retry logic
 * Implements exponential backoff as per Requirement 11.4
 */
export async function connectDatabase(maxRetries = 3): Promise<void> {
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      await prisma.$connect();
      console.log('✅ Database connected successfully');
      return;
    } catch (error) {
      retries++;
      const delay = Math.pow(2, retries) * 1000; // Exponential backoff
      
      console.error(
        `❌ Database connection attempt ${retries}/${maxRetries} failed:`,
        error instanceof Error ? error.message : 'Unknown error'
      );
      
      if (retries < maxRetries) {
        console.log(`⏳ Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw new Error(
          `Failed to connect to database after ${maxRetries} attempts. ` +
          'Please ensure PostgreSQL is running and DATABASE_URL is correct.'
        );
      }
    }
  }
}

/**
 * Disconnect from database gracefully
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  console.log('✅ Database disconnected');
}

/**
 * Health check for database connection
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
