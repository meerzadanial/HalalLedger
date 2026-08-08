# HalalOrNot Database Schema

This directory contains the Prisma schema and migrations for the HalalOrNot Income Tracking System.

## Schema Overview

The database consists of 5 main tables:

### 1. Users Table
- Stores user authentication information
- Fields: id, email, password_hash, created_at, updated_at
- Indexed on: email (unique)

### 2. Income Categories Table
- User-defined categories for income classification
- Fields: id, user_id, name, color_code, description, is_default, created_at, updated_at
- Indexed on: user_id, (user_id, name) unique composite
- Cascades on user deletion

### 3. Income Entries Table
- Individual income records
- Fields: id, user_id, category_id, amount (DECIMAL 12,2), entry_date, notes, created_at, updated_at
- Indexed on: user_id, entry_date, category_id, created_at
- Composite index for duplicate detection: (user_id, entry_date, amount, category_id)
- Cascades on user deletion, restricts on category deletion

### 4. Session Tokens Table
- JWT session management
- Fields: id, user_id, token_hash, expires_at, created_at
- Indexed on: user_id, expires_at, token_hash (unique)
- Cascades on user deletion

### 5. Audit Logs Table
- Tracks all system changes for auditing
- Fields: id, user_id, action, entity_type, entity_id, changes (JSONB), created_at
- Indexed on: user_id, created_at
- Sets user_id to NULL on user deletion

## Database Connection

### Local Development
```bash
DATABASE_URL="postgresql://username:password@localhost:5432/halalornot?schema=public"
```

### Production (AWS RDS with SSL)
```bash
DATABASE_URL="postgresql://username:password@host:port/halalornot?schema=public&sslmode=require"
```

For production deployments:
- Always use SSL/TLS encryption (`sslmode=require`)
- Store DATABASE_URL in AWS Secrets Manager or environment variables
- Use RDS Proxy for connection pooling
- Enable automated backups (daily at 2 AM)

## Running Migrations

### Generate Prisma Client
```bash
npm run db:generate
```

### Apply Migrations (Development)
```bash
npm run db:migrate
```

### Push Schema to Database (Prototyping)
```bash
npm run db:push
```

### View Database in Prisma Studio
```bash
npm run db:studio
```

## Initial Migration

The `20240101000000_init` migration creates the complete schema with:
- All 5 tables
- Primary keys (UUID v4)
- Foreign key constraints
- Indexes for performance
- Cascading delete rules
- Unique constraints

## Security Features

### Requirements Addressed
- **Requirement 7.8**: Database persistence with connection pooling
- **Requirement 11.1**: Encrypted connection strings with SSL support
- **Requirement 11.2**: Prepared statements via Prisma (SQL injection prevention)

### Connection Security
- SSL/TLS encryption for production
- Parameterized queries via Prisma ORM
- Password hashing with bcrypt (stored in password_hash)
- Session token hashing (stored in token_hash)

### Data Isolation
- User-scoped queries via user_id foreign keys
- Cascade deletion ensures data cleanup
- Audit logs for compliance tracking

## Performance Optimizations

- Connection pooling (5-20 connections configured in application)
- Indexed columns for frequent queries:
  - User email lookups
  - Income entry date ranges
  - Category filtering
  - Session token validation
- Composite index for duplicate detection

## Maintenance

- Backups: Automated daily at 2 AM (configured in RDS)
- Retention: 30 days (production)
- Point-in-time recovery: Available in RDS Multi-AZ
- Migration history: Tracked in `migrations` directory
