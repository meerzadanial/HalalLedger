# DatabaseClient

A robust database client implementation with connection pooling, retry logic, transaction management, and prepared statement execution for the HalalOrNot Income Tracking System.

## Features

- ✅ **Connection Pooling**: 5-20 concurrent connections with configurable timeout
- ✅ **Retry Logic**: Automatic retry with exponential backoff (3 attempts)
- ✅ **Transaction Management**: ACID transactions with automatic rollback on failure
- ✅ **Prepared Statements**: SQL injection protection through parameterized queries
- ✅ **Health Monitoring**: Built-in health check functionality
- ✅ **Graceful Shutdown**: Proper connection cleanup on application exit

## Installation

The DatabaseClient is already configured in the backend package. Ensure your `.env` file contains:

```env
DATABASE_URL="postgresql://username:password@localhost:5432/halalornot?schema=public"
```

## Usage

### Basic Initialization

The database client is automatically initialized when the server starts:

```typescript
import { initializeDatabase, closeDatabase } from './database';

// At application startup
const dbClient = await initializeDatabase();

// At application shutdown
await closeDatabase();
```

### Getting the Client Instance

```typescript
import { getDatabaseClient } from './database';

const dbClient = getDatabaseClient();
const prisma = dbClient.getClient();
```

### Executing Transactions

Transactions automatically rollback on error:

```typescript
import { getDatabaseClient } from './database';

const dbClient = getDatabaseClient();

// Execute operations within a transaction
const result = await dbClient.transaction(async (tx) => {
  // Create a category
  const category = await tx.incomeCategory.create({
    data: {
      userId: '123',
      name: 'Salary',
      colorCode: '#FF5733',
    },
  });

  // Create an income entry
  const entry = await tx.incomeEntry.create({
    data: {
      userId: '123',
      categoryId: category.id,
      amount: 1500.00,
      entryDate: new Date(),
    },
  });

  return { category, entry };
});

console.log('Transaction completed:', result);
```

### Raw SQL Queries with Prepared Statements

Execute raw SQL safely with parameter binding:

```typescript
import { getDatabaseClient } from './database';

const dbClient = getDatabaseClient();

// Query with parameters (prevents SQL injection)
const users = await dbClient.query<{ id: string; email: string }[]>(
  'SELECT id, email FROM users WHERE email = $1',
  ['user@example.com']
);

// Query without parameters
const count = await dbClient.query<{ count: number }[]>(
  'SELECT COUNT(*) as count FROM income_entries'
);
```

### Retry Logic

Operations can be retried automatically with exponential backoff:

```typescript
import { getDatabaseClient } from './database';

const dbClient = getDatabaseClient();

// Retry an operation up to 3 times
const result = await dbClient.executeWithRetry(async () => {
  return await prisma.user.findUnique({
    where: { email: 'user@example.com' },
  });
}, 3);
```

### Health Check

Monitor database connection health:

```typescript
import { getDatabaseClient } from './database';

const dbClient = getDatabaseClient();

const isHealthy = await dbClient.healthCheck();
if (!isHealthy) {
  console.error('Database connection is unhealthy!');
}
```

### Connection Pool Information

Get details about the connection pool configuration:

```typescript
import { getDatabaseClient } from './database';

const dbClient = getDatabaseClient();

const poolInfo = dbClient.getPoolInfo();
console.log('Pool configuration:', poolInfo);
// Output: { min: 5, max: 20, timeout: 30000 }
```

## Advanced Usage

### Custom Timeout and Retry Configuration

```typescript
import { DatabaseClient } from './database';

// Create a custom client with 60-second timeout and 5 retry attempts
const customClient = new DatabaseClient(60000, 5);
await customClient.connect();

// Use the custom client
const prisma = customClient.getClient();
```

### Complex Transaction Example

```typescript
import { getDatabaseClient } from './database';

const dbClient = getDatabaseClient();

try {
  const result = await dbClient.transaction(async (tx) => {
    // Update category
    const category = await tx.incomeCategory.update({
      where: { id: categoryId },
      data: { name: 'Updated Salary' },
    });

    // Find all entries with this category
    const entries = await tx.incomeEntry.findMany({
      where: { categoryId: category.id },
    });

    // Update each entry
    await Promise.all(
      entries.map((entry) =>
        tx.incomeEntry.update({
          where: { id: entry.id },
          data: { updatedAt: new Date() },
        })
      )
    );

    return { category, entriesUpdated: entries.length };
  });

  console.log('Updated category and entries:', result);
} catch (error) {
  console.error('Transaction failed:', error);
  // Transaction was automatically rolled back
}
```

### Handling Connection Errors

```typescript
import { initializeDatabase } from './database';

try {
  await initializeDatabase();
  console.log('Database connected successfully');
} catch (error) {
  console.error('Failed to initialize database:', error);
  // Connection was retried 3 times before failing
  process.exit(1);
}
```

## Configuration

### Environment Variables

- `DATABASE_URL`: PostgreSQL connection string (required)
  - Format: `postgresql://username:password@host:port/database?schema=public`
  - Connection pool parameters are automatically added

### Connection Pool Parameters

The client automatically configures the following pool parameters:

- **connection_limit**: Maximum 20 connections
- **pool_timeout**: 30 seconds (default)

These are appended to your DATABASE_URL automatically.

## Error Handling

### Retryable Errors

The following errors trigger automatic retry with exponential backoff:

- `ECONNREFUSED` - Connection refused
- `ETIMEDOUT` - Connection timeout
- `ENOTFOUND` - Host not found
- `ECONNRESET` - Connection reset
- `EPIPE` - Broken pipe
- `Connection terminated`
- `Connection lost`
- `Pool is closed`
- `timeout`

### Non-Retryable Errors

Other errors (validation errors, constraint violations, etc.) are thrown immediately without retry.

## Best Practices

1. **Always use transactions for multi-step operations**
   - Ensures data consistency
   - Automatic rollback on error

2. **Use prepared statements for raw queries**
   - Prevents SQL injection
   - Better performance

3. **Handle connection errors gracefully**
   - Implement retry logic for critical operations
   - Log errors with context

4. **Monitor connection health**
   - Use health checks in your monitoring system
   - Alert on connection issues

5. **Close connections on shutdown**
   - Implement graceful shutdown handlers
   - Prevent connection leaks

## Testing

The DatabaseClient is fully tested with 25 unit tests covering:

- Connection management and retry logic
- Connection pool configuration
- Transaction management and rollback
- Prepared statement execution
- Retry logic with exponential backoff
- Health checks
- Error handling

Run tests:

```bash
npm test -- src/database/client.test.ts
```

## Architecture Compliance

This implementation satisfies the following requirements from the design document:

**Requirement 7.5**: Database persistence with connection pooling
- ✅ 5-20 connection pool
- ✅ 2-second write timeout
- ✅ Rollback on transaction failure

**Requirement 11.3**: Encrypted connection strings
- ✅ TLS/SSL support through DATABASE_URL
- ✅ Secure credential handling

**Requirement 11.4**: Connection timeout configuration
- ✅ Default 30-second timeout
- ✅ Configurable timeout parameter

**Requirement 11.5**: Retry logic with exponential backoff
- ✅ 3 retry attempts
- ✅ Exponential backoff (1s, 2s, 4s)
- ✅ Intelligent error detection

**Requirement 11.6**: Connection pooling
- ✅ Minimum 5 connections
- ✅ Maximum 20 connections
- ✅ Prepared statement support (SQL injection prevention)

## License

Part of the HalalOrNot Income Tracking System.
