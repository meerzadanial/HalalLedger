/**
 * Database module exports
 * 
 * Provides database client with connection pooling, retry logic,
 * transaction management, and prepared statement execution.
 */

export {
  DatabaseClient,
  getDatabaseClient,
  initializeDatabase,
  closeDatabase,
} from './client';
