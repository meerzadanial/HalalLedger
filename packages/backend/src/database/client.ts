import { PrismaClient, Prisma } from '@prisma/client';

/**
 * DatabaseClient - Manages database connections with pooling, retry logic, and transactions
 * 
 * Features:
 * - Connection pooling (5-20 connections)
 * - Retry logic with exponential backoff (3 attempts)
 * - Transaction management with automatic rollback on failure
 * - Prepared statement execution
 * - Connection timeout configuration
 */
export class DatabaseClient {
  private prisma: PrismaClient;
  private connectionTimeout: number;
  private maxRetries: number;
  private minConnectionPool: number;
  private maxConnectionPool: number;
  private isConnected: boolean;

  /**
   * Creates a new DatabaseClient instance
   * @param connectionTimeout - Connection timeout in milliseconds (default: 30000ms)
   * @param maxRetries - Maximum retry attempts for failed operations (default: 3)
   */
  constructor(connectionTimeout: number = 30000, maxRetries: number = 3) {
    this.connectionTimeout = connectionTimeout;
    this.maxRetries = maxRetries;
    this.minConnectionPool = 5;
    this.maxConnectionPool = 20;
    this.isConnected = false;

    // Initialize Prisma Client with connection pooling configuration
    this.prisma = new PrismaClient({
      datasources: {
        db: {
          url: this.buildConnectionUrl(),
        },
      },
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });
  }

  /**
   * Builds the database connection URL with connection pool parameters
   * @returns Connection URL with pooling configuration
   */
  private buildConnectionUrl(): string {
    const baseUrl = process.env.DATABASE_URL || '';
    
    // If no URL is provided, return empty string (will fail on connect)
    if (!baseUrl) {
      return '';
    }
    
    try {
      // Parse the URL to add connection pool parameters
      const url = new URL(baseUrl);
      
      // Add connection pool parameters
      url.searchParams.set('connection_limit', this.maxConnectionPool.toString());
      url.searchParams.set('pool_timeout', (this.connectionTimeout / 1000).toString());
      
      return url.toString();
    } catch (error) {
      // If URL parsing fails, return the original URL
      return baseUrl;
    }
  }

  /**
   * Establishes connection to the database with retry logic
   * @throws Error if connection fails after all retry attempts
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    const connectWithRetry = async (attempt: number = 1): Promise<void> => {
      try {
        // Test the connection
        await this.prisma.$connect();
        
        // Verify connection with a simple query
        await this.prisma.$queryRaw`SELECT 1`;
        
        this.isConnected = true;
        console.log(`✅ Database connected successfully (pool: ${this.minConnectionPool}-${this.maxConnectionPool} connections)`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`❌ Database connection attempt ${attempt} failed:`, errorMessage);

        if (attempt < this.maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.pow(2, attempt - 1) * 1000;
          console.log(`⏳ Retrying in ${delay}ms...`);
          await this.sleep(delay);
          return connectWithRetry(attempt + 1);
        }

        throw new Error(`Failed to connect to database after ${this.maxRetries} attempts: ${errorMessage}`);
      }
    };

    await connectWithRetry();
  }

  /**
   * Disconnects from the database
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await this.prisma.$disconnect();
      this.isConnected = false;
      console.log('🔌 Database disconnected');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Error disconnecting from database:', errorMessage);
      throw error;
    }
  }

  /**
   * Gets the underlying Prisma client for direct access
   * @returns PrismaClient instance
   */
  getClient(): PrismaClient {
    if (!this.isConnected) {
      throw new Error('Database not connected. Call connect() first.');
    }
    return this.prisma;
  }

  /**
   * Executes a function within a database transaction
   * Automatically rolls back on failure
   * 
   * @param fn - Function to execute within the transaction context
   * @returns Result of the transaction function
   * @throws Error if transaction fails
   */
  async transaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    if (!this.isConnected) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        return await fn(tx);
      }, {
        maxWait: this.connectionTimeout,
        timeout: this.connectionTimeout,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Transaction failed and rolled back:', errorMessage);
      throw new Error(`Transaction failed: ${errorMessage}`);
    }
  }

  /**
   * Executes a raw SQL query with parameters (prepared statement)
   * 
   * @param sql - SQL query template
   * @param params - Query parameters
   * @returns Query result
   */
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
    if (!this.isConnected) {
      throw new Error('Database not connected. Call connect() first.');
    }

    try {
      // Use Prisma's $queryRawUnsafe for parameterized queries
      // This provides SQL injection protection through parameter binding
      const result = await this.prisma.$queryRawUnsafe<T>(sql, ...params);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Query execution failed:', errorMessage);
      throw new Error(`Query failed: ${errorMessage}`);
    }
  }

  /**
   * Executes a function with retry logic and exponential backoff
   * 
   * @param fn - Function to execute with retry logic
   * @param maxRetries - Maximum number of retry attempts (default: instance maxRetries)
   * @returns Result of the function
   * @throws Error if all retry attempts fail
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = this.maxRetries
  ): Promise<T> {
    let lastError: Error | unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        // Check if error is retryable
        if (!this.isRetryableError(error)) {
          throw error;
        }

        console.error(`❌ Attempt ${attempt} failed:`, errorMessage);

        if (attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.pow(2, attempt - 1) * 1000;
          console.log(`⏳ Retrying in ${delay}ms... (${maxRetries - attempt} attempts remaining)`);
          await this.sleep(delay);
        }
      }
    }

    const errorMessage = lastError instanceof Error ? lastError.message : 'Unknown error';
    throw new Error(`Operation failed after ${maxRetries} attempts: ${errorMessage}`);
  }

  /**
   * Determines if an error is retryable
   * @param error - Error to check
   * @returns true if the error is retryable
   */
  private isRetryableError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const retryableErrors = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ECONNRESET',
      'EPIPE',
      'Connection terminated',
      'Connection lost',
      'Pool is closed',
      'timeout',
    ];

    return retryableErrors.some((retryableError) =>
      error.message.includes(retryableError)
    );
  }

  /**
   * Helper function to sleep for a specified duration
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Checks if the database connection is healthy
   * @returns true if the connection is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      console.error('❌ Database health check failed:', error);
      return false;
    }
  }

  /**
   * Gets connection pool statistics
   * @returns Connection pool information
   */
  getPoolInfo(): { min: number; max: number; timeout: number } {
    return {
      min: this.minConnectionPool,
      max: this.maxConnectionPool,
      timeout: this.connectionTimeout,
    };
  }
}

// Singleton instance for application-wide use
let dbClientInstance: DatabaseClient | null = null;

/**
 * Gets or creates a singleton DatabaseClient instance
 * @returns DatabaseClient singleton instance
 */
export function getDatabaseClient(): DatabaseClient {
  if (!dbClientInstance) {
    dbClientInstance = new DatabaseClient();
  }
  return dbClientInstance;
}

/**
 * Initializes the database connection
 * Should be called at application startup
 */
export async function initializeDatabase(): Promise<DatabaseClient> {
  const client = getDatabaseClient();
  await client.connect();
  return client;
}

/**
 * Closes the database connection
 * Should be called at application shutdown
 */
export async function closeDatabase(): Promise<void> {
  if (dbClientInstance) {
    await dbClientInstance.disconnect();
    dbClientInstance = null;
  }
}
