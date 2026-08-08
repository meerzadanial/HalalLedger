# Design Document: HalalOrNot Income Tracking System

## Overview

The HalalOrNot Income Tracking System is a cloud-based web application that replaces an existing iOS Shortcuts + Google Sheets solution with a modern, database-backed architecture. The system enables users to categorize, track, and analyze income entries through a responsive web interface with persistent storage in a cloud-hosted relational database.

### Key Design Goals

1. **Cloud Accessibility**: Browser-based interface accessible from any device without installation
2. **Data Persistence**: Reliable database storage replacing Google Sheets for better querying and data integrity
3. **Security**: Encrypted authentication, isolated user data, and SQL injection prevention
4. **Responsiveness**: Mobile-optimized UI with fast load times (<3 seconds)
5. **Data Migration**: Seamless import from existing Google Sheets data
6. **Extensibility**: Support for custom income categories and future feature expansion

### Technology Stack Recommendations

Based on the requirements, the following AWS-based stack is recommended:

**Frontend:**
- **React** with TypeScript for type safety and component reusability
- **TailwindCSS** for responsive design across device sizes (320px-2560px)
- **React Query** for efficient data fetching and caching
- **React Hook Form** for form validation and submission
- **Hosted on AWS Amplify** or **AWS S3 + CloudFront** for global CDN distribution

**Backend:**
- **Node.js** with **Express.js** for RESTful API
- **TypeScript** for end-to-end type safety
- **Hosted on AWS Lambda** (serverless) or **AWS ECS/Fargate** (containerized)
- **API Gateway** for API management, throttling, and security
- **Prisma ORM** for type-safe database queries and migrations

**Database:**
- **AWS RDS PostgreSQL** (managed relational database with automated backups)
- Multi-AZ deployment for high availability
- Automated daily backups with point-in-time recovery
- Connection pooling via RDS Proxy

**Authentication:**
- **AWS Cognito** for user authentication and authorization
- JWT token generation with 30-minute expiration
- Password hashing with bcrypt
- Multi-user support with data isolation

**Storage & CDN:**
- **AWS S3** for static asset storage
- **CloudFront** for global content delivery and HTTPS

**Monitoring & Logging:**
- **AWS CloudWatch** for application logs and metrics
- **CloudWatch Alarms** for uptime monitoring and alerts
- **AWS X-Ray** for distributed tracing and performance analysis

**Security:**
- **AWS Secrets Manager** for database credentials and JWT secrets
- **AWS WAF** (Web Application Firewall) for API protection
- **VPC** (Virtual Private Cloud) for network isolation
- **Security Groups** for fine-grained access control

**CI/CD:**
- **AWS CodePipeline** for automated deployments
- **AWS CodeBuild** for building and testing
- **GitHub Actions** (alternative) for CI/CD workflows

## Architecture

### AWS Cloud Architecture

The system follows a modern serverless/containerized AWS architecture for scalability, reliability, and cost-efficiency:

```
┌──────────────────────────────────────────────────────────────────┐
│                         USERS / CLIENTS                          │
│              (Mobile, Tablet, Desktop Browsers)                  │
└────────────────────────────┬─────────────────────────────────────┘
                             │ HTTPS
┌────────────────────────────▼─────────────────────────────────────┐
│                      AWS CLOUDFRONT (CDN)                        │
│  - Global content delivery                                       │
│  - HTTPS/SSL termination                                         │
│  - DDoS protection                                               │
└────────────────────────────┬─────────────────────────────────────┘
                             │
        ┌────────────────────┴────────────────────┐
        │                                         │
┌───────▼──────────────┐              ┌──────────▼──────────────┐
│   AWS S3 (Static)    │              │   AWS API GATEWAY       │
│  - React Frontend    │              │  - REST API endpoints   │
│  - Static assets     │              │  - Request throttling   │
│  - Build artifacts   │              │  - API key management   │
└──────────────────────┘              │  - CORS handling        │
                                      └──────────┬──────────────┘
                                                 │
                     ┌───────────────────────────┴────────────────┐
                     │                                            │
          ┌──────────▼──────────┐                    ┌───────────▼────────┐
          │   AWS COGNITO       │                    │   AWS WAF          │
          │  - User pools       │                    │  - SQL injection   │
          │  - JWT tokens       │                    │    prevention      │
          │  - 30min sessions   │                    │  - Rate limiting   │
          └─────────────────────┘                    └────────────────────┘
                     
┌─────────────────────────────────────────────────────────────────┐
│                   AWS LAMBDA / ECS FARGATE                      │
│                   (APPLICATION TIER)                            │
│  ┌────────────────────────────────────────────────────────┐    │
│  │  Lambda Functions / Container Services                 │    │
│  │  ┌──────────────────────────────────────────────┐      │    │
│  │  │  Authentication Service                      │      │    │
│  │  │  - AWS Cognito integration                   │      │    │
│  │  │  - Session validation                        │      │    │
│  │  └──────────────────────────────────────────────┘      │    │
│  │  ┌──────────────────────────────────────────────┐      │    │
│  │  │  Income Service                              │      │    │
│  │  │  - Entry CRUD operations                     │      │    │
│  │  │  - Automatic income segregation              │      │    │
│  │  │  - Validation & filtering                    │      │    │
│  │  └──────────────────────────────────────────────┘      │    │
│  │  ┌──────────────────────────────────────────────┐      │    │
│  │  │  Category Service                            │      │    │
│  │  │  - Category management                       │      │    │
│  │  └──────────────────────────────────────────────┘      │    │
│  │  ┌──────────────────────────────────────────────┐      │    │
│  │  │  Database Client (Prisma + RDS Proxy)        │      │    │
│  │  │  - Connection pooling                        │      │    │
│  │  │  - Prepared statements                       │      │    │
│  │  │  - Transaction management                    │      │    │
│  │  └─────────────────┬────────────────────────────┘      │    │
│  └────────────────────┼─────────────────────────────────────┘    │
└───────────────────────┼──────────────────────────────────────────┘
                        │
                        │ via RDS Proxy
┌───────────────────────▼──────────────────────────────────────────┐
│                      AWS VPC (Isolated Network)                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              AWS RDS PROXY                                │  │
│  │  - Connection pooling and management                      │  │
│  │  - Improved scalability for Lambda functions              │  │
│  └──────────────────────┬────────────────────────────────────┘  │
│                         │                                        │
│  ┌──────────────────────▼────────────────────────────────────┐  │
│  │         AWS RDS POSTGRESQL (Multi-AZ)                     │  │
│  │  Primary DB ─────────┬─────────► Standby DB (failover)   │  │
│  │  - Users table       │                                    │  │
│  │  - Income entries    │                                    │  │
│  │  - Categories        │                                    │  │
│  │  - Session tokens    │                                    │  │
│  │  - Audit logs        │                                    │  │
│  └──────────────────────┼────────────────────────────────────┘  │
└───────────────────────────┼──────────────────────────────────────┘
                            │
                    ┌───────▼────────┐
                    │  AWS S3        │
                    │  (DB Backups)  │
                    │  - Daily 2AM   │
                    │  - 30-day      │
                    │    retention   │
                    └────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                   MONITORING & SECURITY                          │
│  ┌──────────────────┐  ┌────────────────────┐  ┌─────────────┐  │
│  │ AWS CLOUDWATCH   │  │ AWS SECRETS MGR    │  │  AWS X-RAY  │  │
│  │ - App logs       │  │ - DB credentials   │  │ - Tracing   │  │
│  │ - Metrics        │  │ - JWT secrets      │  │ - Performance│ │
│  │ - Alarms (99%)   │  │ - API keys         │  │ - Debugging │  │
│  └──────────────────┘  └────────────────────┘  └─────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### AWS Architecture Benefits

1. **Scalability**: Auto-scaling with Lambda or ECS Fargate handles traffic spikes automatically
2. **High Availability**: Multi-AZ RDS deployment ensures 99% uptime with automatic failover
3. **Cost Efficiency**: Pay-per-use pricing with Lambda (no idle server costs)
4. **Security**: VPC isolation, Secrets Manager, WAF, and Cognito provide enterprise-grade security
5. **Global Performance**: CloudFront CDN delivers content from edge locations worldwide
6. **Managed Services**: AWS handles infrastructure, patching, and maintenance
7. **Backup & Recovery**: Automated daily backups with point-in-time recovery

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT TIER                          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │          Web Browser (React + TailwindCSS)            │  │
│  │  - Income Entry Forms                                 │  │
│  │  - Category Management UI                             │  │
│  │  - Dashboard & Filtering Views                        │  │
│  │  - Authentication UI                                  │  │
│  └────────────────┬──────────────────────────────────────┘  │
└─────────────────────┼──────────────────────────────────────┘
                      │ HTTPS/REST API
┌─────────────────────┼──────────────────────────────────────┐
│                     │    APPLICATION TIER                   │
│  ┌──────────────────▼──────────────────────────────────┐   │
│  │          API Server (Node.js + Express)             │   │
│  │  ┌────────────────────────────────────────────┐     │   │
│  │  │     Authentication Service                 │     │   │
│  │  │  - Credential validation                   │     │   │
│  │  │  - Session management (30min timeout)      │     │   │
│  │  │  - User isolation                          │     │   │
│  │  └────────────────────────────────────────────┘     │   │
│  │  ┌────────────────────────────────────────────┐     │   │
│  │  │     Income Service                         │     │   │
│  │  │  - Entry creation/update/delete            │     │   │
│  │  │  - Validation logic                        │     │   │
│  │  │  - Filtering & aggregation                 │     │   │
│  │  └────────────────────────────────────────────┘     │   │
│  │  ┌────────────────────────────────────────────┐     │   │
│  │  │     Category Service                       │     │   │
│  │  │  - Category CRUD operations                │     │   │
│  │  │  - Uniqueness validation                   │     │   │
│  │  └────────────────────────────────────────────┘     │   │
│  │  ┌────────────────────────────────────────────┐     │   │
│  │  │     Migration Service                      │     │   │
│  │  │  - CSV parsing & validation                │     │   │
│  │  │  - Duplicate detection                     │     │   │
│  │  │  - Batch import processing                 │     │   │
│  │  └────────────────────────────────────────────┘     │   │
│  │  ┌────────────────────────────────────────────┐     │   │
│  │  │     Database Client (Prisma)               │     │   │
│  │  │  - Connection pooling (5-20 connections)   │     │   │
│  │  │  - Prepared statements                     │     │   │
│  │  │  - Transaction management                  │     │   │
│  │  │  - Retry logic with exponential backoff    │     │   │
│  │  └────────────────┬───────────────────────────┘     │   │
│  └────────────────────┼───────────────────────────────┘   │
└─────────────────────────┼──────────────────────────────────┘
                          │ SQL over TLS
┌───────────────────────┼────────────────────────────────────┐
│                       │       DATA TIER                     │
│  ┌────────────────────▼────────────────────────────────┐   │
│  │          PostgreSQL Database (AWS RDS)              │   │
│  │  - User authentication data                         │   │
│  │  - Income entries                                   │   │
│  │  - Income categories                                │   │
│  │  - Audit logs                                       │   │
│  │  - Automated daily backups (2 AM)                   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Component Interaction Flow

**Income Entry Creation Flow (AWS):**
```
User → CloudFront → S3 (React App) → API Gateway 
  → Lambda/ECS (Income Service) 
  → Validation
  → RDS Proxy → RDS PostgreSQL
  → Response ← Lambda ← API Gateway ← CloudFront ← User
```

**Authentication Flow (AWS Cognito):**
```
User → Login Form → API Gateway → Lambda (Auth Service)
  → AWS Cognito (Credential Validation)
  → JWT Token Generation (30min expiry)
  → Cognito authorizer validates subsequent API requests
  → Protected API Access via API Gateway
```

### Deployment Options

**Option 1: Serverless (Recommended for MVP)**
- Frontend: AWS Amplify or S3 + CloudFront
- Backend: AWS Lambda functions with API Gateway
- Database: AWS RDS PostgreSQL with RDS Proxy
- Best for: Variable traffic, cost optimization, minimal ops overhead

**Option 2: Containerized (For predictable traffic)**
- Frontend: AWS Amplify or S3 + CloudFront  
- Backend: AWS ECS Fargate with Application Load Balancer
- Database: AWS RDS PostgreSQL Multi-AZ
- Best for: Consistent traffic, complex deployments, more control

### Separation of Concerns

- **Presentation Layer**: React components handle only UI rendering and user interaction
- **Business Logic Layer**: Service classes contain validation, transformation, and aggregation logic
- **Data Access Layer**: Database Client (Prisma) handles all database operations with connection pooling
- **Authentication Layer**: Isolated authentication service manages user sessions and access control

## Components and Interfaces

### Frontend Components

#### 1. Authentication Module
```typescript
interface AuthenticationProps {
  onLoginSuccess: (token: string) => void;
  onLoginFailure: (error: string) => void;
}

// LoginForm component
// - Email/password input fields
// - Validation feedback
// - Session management with 30-minute timeout
// - Automatic re-authentication on expiry
```

#### 2. Income Entry Form
```typescript
interface IncomeEntryFormData {
  amount: number;          // Max 2 decimal places
  categoryId: string;      // Foreign key to categories
  date: Date;              // Defaults to current date, no future dates
  notes?: string;          // Optional, max 500 chars
}

interface IncomeEntryFormProps {
  onSubmit: (data: IncomeEntryFormData) => Promise<void>;
  categories: IncomeCategory[];
  existingEntry?: IncomeEntry; // For edit mode
}
```

#### 3. Dashboard Component
```typescript
interface DashboardProps {
  entries: IncomeEntry[];
  categories: IncomeCategory[];
  filters: FilterOptions;
  onFilterChange: (filters: FilterOptions) => void;
}

interface FilterOptions {
  dateRange?: { start: Date; end: Date };
  categoryIds?: string[];
}
```

#### 4. Category Management Component
```typescript
interface CategoryFormData {
  name: string;            // Must be unique
  colorCode: string;       // Hex color for visual identification
  description?: string;
}

interface CategoryManagementProps {
  categories: IncomeCategory[];
  onCreateCategory: (data: CategoryFormData) => Promise<void>;
  onUpdateCategory: (id: string, data: CategoryFormData) => Promise<void>;
  onDeleteCategory: (id: string) => Promise<void>;
}
```

### Backend API Endpoints

#### Authentication Endpoints
```
POST   /api/auth/login
  Body: { email: string, password: string }
  Response: { token: string, expiresAt: string }
  
POST   /api/auth/logout
  Headers: { Authorization: "Bearer <token>" }
  Response: { success: boolean }

GET    /api/auth/session
  Headers: { Authorization: "Bearer <token>" }
  Response: { userId: string, email: string, expiresAt: string }
```

#### Income Entry Endpoints
```
POST   /api/income-entries
  Headers: { Authorization: "Bearer <token>" }
  Body: IncomeEntryFormData
  Response: { entry: IncomeEntry }
  
GET    /api/income-entries
  Headers: { Authorization: "Bearer <token>" }
  Query: { startDate?, endDate?, categoryId?, limit?, offset? }
  Response: { entries: IncomeEntry[], total: number }
  
PUT    /api/income-entries/:id
  Headers: { Authorization: "Bearer <token>" }
  Body: Partial<IncomeEntryFormData>
  Response: { entry: IncomeEntry }
  
DELETE /api/income-entries/:id
  Headers: { Authorization: "Bearer <token>" }
  Response: { success: boolean }
```

#### Category Endpoints
```
GET    /api/categories
  Headers: { Authorization: "Bearer <token>" }
  Response: { categories: IncomeCategory[] }
  
POST   /api/categories
  Headers: { Authorization: "Bearer <token>" }
  Body: CategoryFormData
  Response: { category: IncomeCategory }
  
PUT    /api/categories/:id
  Headers: { Authorization: "Bearer <token>" }
  Body: Partial<CategoryFormData>
  Response: { category: IncomeCategory }
  
DELETE /api/categories/:id
  Headers: { Authorization: "Bearer <token>" }
  Query: { reassignTo?: string }
  Response: { success: boolean }
```

#### Migration Endpoints
```
POST   /api/migration/csv
  Headers: { Authorization: "Bearer <token>" }
  Body: FormData with CSV file
  Response: { 
    success: boolean, 
    imported: number, 
    errors: { row: number, message: string }[] 
  }
  
POST   /api/migration/google-sheets
  Headers: { Authorization: "Bearer <token>" }
  Body: { sheetUrl: string }
  Response: { 
    success: boolean, 
    imported: number, 
    errors: { row: number, message: string }[] 
  }
```

#### Analytics Endpoints
```
GET    /api/analytics/totals
  Headers: { Authorization: "Bearer <token>" }
  Query: { startDate?, endDate?, categoryId? }
  Response: { 
    totalAmount: number,
    categoryBreakdown: { categoryId: string, total: number }[]
  }
```

### Backend Services

#### 1. Authentication Service
```typescript
class AuthenticationService {
  async login(email: string, password: string): Promise<{ token: string, expiresAt: Date }>;
  async validateToken(token: string): Promise<{ userId: string, email: string }>;
  async logout(token: string): Promise<void>;
  async hashPassword(password: string): Promise<string>;
  async verifyPassword(password: string, hash: string): Promise<boolean>;
}
```

#### 2. Income Service
```typescript
class IncomeService {
  async createEntry(userId: string, data: IncomeEntryFormData): Promise<IncomeEntry>;
  async updateEntry(userId: string, entryId: string, data: Partial<IncomeEntryFormData>): Promise<IncomeEntry>;
  async deleteEntry(userId: string, entryId: string): Promise<void>;
  async getEntries(userId: string, filters: FilterOptions): Promise<{ entries: IncomeEntry[], total: number }>;
  async calculateTotals(userId: string, filters: FilterOptions): Promise<{ total: number, byCategory: Map<string, number> }>;
  validateEntryData(data: IncomeEntryFormData): ValidationResult;
  checkDuplicate(userId: string, data: IncomeEntryFormData): Promise<boolean>;
}
```

#### 3. Category Service
```typescript
class CategoryService {
  async createCategory(userId: string, data: CategoryFormData): Promise<IncomeCategory>;
  async updateCategory(userId: string, categoryId: string, data: Partial<CategoryFormData>): Promise<IncomeCategory>;
  async deleteCategory(userId: string, categoryId: string, reassignTo?: string): Promise<void>;
  async getCategories(userId: string): Promise<IncomeCategory[]>;
  async checkUniqueness(userId: string, name: string, excludeId?: string): Promise<boolean>;
  async getDefaultCategories(): Promise<CategoryFormData[]>;
}
```

#### 4. Migration Service
```typescript
class MigrationService {
  async parseCSV(file: File): Promise<IncomeEntryFormData[]>;
  async validateMigrationData(entries: IncomeEntryFormData[]): Promise<ValidationResult[]>;
  async importEntries(userId: string, entries: IncomeEntryFormData[]): Promise<{ imported: number, errors: MigrationError[] }>;
  async detectDuplicates(userId: string, entries: IncomeEntryFormData[]): Promise<number[]>;
  async importFromGoogleSheets(userId: string, sheetUrl: string): Promise<{ imported: number, errors: MigrationError[] }>;
}
```

#### 5. Database Client (Prisma)
```typescript
class DatabaseClient {
  // Connection management
  async connect(): Promise<void>;
  async disconnect(): Promise<void>;
  getConnectionPool(): ConnectionPool;
  
  // Transaction management
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  
  // Query execution
  async query<T>(sql: string, params: any[]): Promise<T>;
  
  // Error handling
  async executeWithRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T>;
}
```

## Data Models

### Database Schema (PostgreSQL)

```sql
-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);

-- Income Categories table
CREATE TABLE income_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  color_code VARCHAR(7) NOT NULL, -- Hex color #RRGGBB
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
);

CREATE INDEX idx_categories_user_id ON income_categories(user_id);

-- Income Entries table
CREATE TABLE income_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES income_categories(id) ON DELETE RESTRICT,
  amount DECIMAL(12, 2) NOT NULL CHECK (amount >= 0),
  entry_date DATE NOT NULL CHECK (entry_date <= CURRENT_DATE),
  notes TEXT CHECK (LENGTH(notes) <= 500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_entries_user_id ON income_entries(user_id);
CREATE INDEX idx_entries_entry_date ON income_entries(entry_date);
CREATE INDEX idx_entries_category_id ON income_entries(category_id);
CREATE INDEX idx_entries_created_at ON income_entries(created_at);

-- Composite index for duplicate detection
CREATE INDEX idx_entries_duplicate_check 
  ON income_entries(user_id, entry_date, amount, category_id);

-- Session tokens table (for session management)
CREATE TABLE session_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_session_tokens_user_id ON session_tokens(user_id);
CREATE INDEX idx_session_tokens_expires_at ON session_tokens(expires_at);

-- Audit log table (optional, for tracking changes)
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL, -- CREATE, UPDATE, DELETE
  entity_type VARCHAR(50) NOT NULL, -- income_entry, category
  entity_id UUID NOT NULL,
  changes JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
```

### TypeScript Data Models (Prisma Schema)

```prisma
model User {
  id            String           @id @default(uuid())
  email         String           @unique
  passwordHash  String           @map("password_hash")
  createdAt     DateTime         @default(now()) @map("created_at")
  updatedAt     DateTime         @updatedAt @map("updated_at")
  
  categories    IncomeCategory[]
  entries       IncomeEntry[]
  sessions      SessionToken[]
  auditLogs     AuditLog[]
  
  @@map("users")
}

model IncomeCategory {
  id          String        @id @default(uuid())
  userId      String        @map("user_id")
  name        String
  colorCode   String        @map("color_code")
  description String?
  isDefault   Boolean       @default(false) @map("is_default")
  createdAt   DateTime      @default(now()) @map("created_at")
  updatedAt   DateTime      @updatedAt @map("updated_at")
  
  user        User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  entries     IncomeEntry[]
  
  @@unique([userId, name])
  @@index([userId])
  @@map("income_categories")
}

model IncomeEntry {
  id         String         @id @default(uuid())
  userId     String         @map("user_id")
  categoryId String         @map("category_id")
  amount     Decimal        @db.Decimal(12, 2)
  entryDate  DateTime       @map("entry_date") @db.Date
  notes      String?
  createdAt  DateTime       @default(now()) @map("created_at")
  updatedAt  DateTime       @updatedAt @map("updated_at")
  
  user       User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  category   IncomeCategory @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  
  @@index([userId])
  @@index([entryDate])
  @@index([categoryId])
  @@index([createdAt])
  @@index([userId, entryDate, amount, categoryId])
  @@map("income_entries")
}

model SessionToken {
  id        String   @id @default(uuid())
  userId    String   @map("user_id")
  tokenHash String   @unique @map("token_hash")
  expiresAt DateTime @map("expires_at")
  createdAt DateTime @default(now()) @map("created_at")
  
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  @@index([userId])
  @@index([expiresAt])
  @@map("session_tokens")
}

model AuditLog {
  id         String   @id @default(uuid())
  userId     String?  @map("user_id")
  action     String
  entityType String   @map("entity_type")
  entityId   String   @map("entity_id")
  changes    Json?
  createdAt  DateTime @default(now()) @map("created_at")
  
  user       User?    @relation(fields: [userId], references: [id], onDelete: SetNull)
  
  @@index([userId])
  @@index([createdAt])
  @@map("audit_logs")
}
```

### Domain Model Interfaces

```typescript
interface User {
  id: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

interface IncomeCategory {
  id: string;
  userId: string;
  name: string;
  colorCode: string;
  description?: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface IncomeEntry {
  id: string;
  userId: string;
  categoryId: string;
  amount: number;
  entryDate: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
  category?: IncomeCategory; // Populated in queries
}

interface SessionToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

interface ValidationResult {
  isValid: boolean;
  errors: { field: string; message: string }[];
}

interface MigrationError {
  row: number;
  field?: string;
  message: string;
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

This system includes several areas suitable for property-based testing: validation logic, income categorization, aggregation calculations, and CSV import/export. While many requirements involve integration concerns (database operations, authentication, UI rendering), the core business logic and data transformation functions benefit from property-based verification.

### Property 1: User Data Isolation

*For any* two distinct users and any income entry created by one user, querying income entries for the other user SHALL NOT return the first user's entry.

**Validates: Requirements 1.5**

### Property 2: Conditional Workflow Display

*For any* delivery entry, if the cash order indicator is set to "yes", the workflow SHALL display Step 5 requesting cash amount; if set to "no", the workflow SHALL skip Step 5 and proceed directly to save.

**Validates: Requirements 2.5, 2.6**

### Property 3: Restaurant Status Categorization

*For any* delivery entry with restaurant status, the income tracker SHALL classify all income (fare amount + cash amount) as Halal_Income when status is "halal" and as NonHalal_Income when status is "non-halal".

**Validates: Requirements 3.1, 3.2, 3.3**

### Property 4: Income Aggregation Accuracy

*For any* set of delivery entries, the sum of all fare amounts and cash amounts grouped by restaurant status SHALL equal the total Halal_Income and total NonHalal_Income respectively.

**Validates: Requirements 3.4, 3.5, 4.4, 4.5**

### Property 5: Payment Type Classification and Aggregation

*For any* set of delivery entries, the sum of all fare amounts SHALL equal the total digital income, and the sum of all cash amounts SHALL equal the total cash income, with each entry's amounts stored and tracked separately.

**Validates: Requirements 4.1, 4.3, 4.4, 4.5, 4.6, 4.7**

### Property 6: Restaurant Name Input Validation

*For any* input string, the income tracker SHALL accept restaurant names up to 100 characters and reject empty or whitespace-only strings with a validation error.

**Validates: Requirements 5.1, 5.2**

### Property 7: Restaurant Name Preservation

*For any* restaurant name string entered by a user, storing and retrieving the name SHALL preserve the exact capitalization and spelling as originally entered.

**Validates: Requirements 5.5**

### Property 8: Autocomplete Matching

*For any* search query and set of previously entered restaurant names, the autocomplete system SHALL return up to 10 names that match the query, ordered by relevance.

**Validates: Requirements 5.4**

### Property 9: Amount Input Validation

*For any* input string intended as a fare amount or cash amount, the income tracker SHALL accept only numeric values with up to 2 decimal places that are greater than zero, rejecting all other inputs with specific validation error messages.

**Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6**

### Property 10: Transaction Atomicity

*For any* database transaction that fails partway through execution, the database client SHALL rollback all partial changes, ensuring the database state remains consistent as if the transaction never occurred.

**Validates: Requirements 7.5**

### Property 11: Database Error Logging

*For any* database error that occurs during operation, the database client SHALL log the error with a timestamp and error details.

**Validates: Requirements 7.7**

### Property 12: Delivery Entry Round-Trip Persistence

*For any* valid delivery entry with restaurant name, restaurant status, fare amount, cash order indicator, optional cash amount, date, and timestamp, storing the entry to the database and retrieving it SHALL return an equivalent entry with all fields preserved.

**Validates: Requirements 7.8**

### Property 13: Entry List Sorting

*For any* set of delivery entries with different entry dates, displaying the entries SHALL show them in reverse chronological order (newest first).

**Validates: Requirements 8.1**

### Property 14: Date Range Filtering

*For any* date range filter (start date, end date) and any set of delivery entries, applying the filter SHALL return only entries with entry dates within the specified range (inclusive).

**Validates: Requirements 8.2**

### Property 15: Status and Payment Type Filtering

*For any* combination of restaurant status filter and payment type filter applied to a set of delivery entries, the system SHALL return only entries that match all selected filter criteria.

**Validates: Requirements 8.3, 8.4**

### Property 16: Filtered Income Aggregation

*For any* active filter (date range, status, payment type) and any set of delivery entries, the calculated totals for Halal_Income, NonHalal_Income, cash income, and digital income SHALL include only entries matching the filter criteria.

**Validates: Requirements 8.5, 8.6, 8.7**

### Property 17: CSV Export Round-Trip

*For any* set of filtered delivery entries, exporting to CSV and parsing the resulting file SHALL preserve all entry data including restaurant names, statuses, amounts, dates, and timestamps.

**Validates: Requirements 8.8**

### Property 18: Workflow Validation

*For any* incomplete delivery entry missing required fields (restaurant name or restaurant status), the workflow SHALL prevent progression to subsequent steps until the required field is provided.

**Validates: Requirements 9.3**

### Property 19: Workflow State Preservation

*For any* delivery entry being created, navigating backward to a previous step and then forward again SHALL preserve all previously entered values.

**Validates: Requirements 9.4, 9.5**

### Property 20: SQL Injection Prevention

*For any* user input string (including malicious SQL injection attempts), the database client SHALL safely execute queries using prepared statements without allowing SQL code execution from user input.

**Validates: Requirements 11.5**

### Property 21: Automatic Date Assignment

*For any* delivery entry created without a manually specified date, the system SHALL automatically assign the current date as the entry date.

**Validates: Requirements 12.1, 12.2**

### Property 22: Past Date Acceptance and Future Date Rejection

*For any* manually entered date, the system SHALL accept dates in the past or present and reject dates in the future with a validation error.

**Validates: Requirements 12.3, 12.4**

### Property 23: Timezone Display

*For any* entry timestamp, the system SHALL display the timestamp converted to the user's local timezone.

**Validates: Requirements 12.5**

### Property 24: CSV Import Validation

*For any* uploaded CSV file, the import system SHALL validate the file format and required columns (restaurant name, restaurant status, fare amount, cash order indicator, cash amount, date) before processing, rejecting invalid files with a detailed error report indicating problematic rows.

**Validates: Requirements 14.2, 14.4**

### Property 25: CSV Import Data Preservation

*For any* valid CSV file containing delivery entry records, importing the file SHALL create corresponding database entries with all data preserved (restaurant names, restaurant statuses, amounts, dates) and automatic income segregation applied based on restaurant status.

**Validates: Requirements 14.1, 14.3, 14.7**

### Property 26: Duplicate Import Prevention

*For any* CSV import containing entries that match existing database records (same date, restaurant name, and amounts), the import system SHALL detect and skip these duplicates.

**Validates: Requirements 14.5**

### Property 27: Entry Edit Pre-Fill

*For any* existing delivery entry selected for editing, the workflow SHALL display with all form fields pre-filled with the entry's current values.

**Validates: Requirements 15.1**

### Property 28: Entry Update Re-Categorization

*For any* delivery entry update that changes the restaurant status, the system SHALL re-apply automatic income segregation based on the new status.

**Validates: Requirements 15.2**

### Property 29: Entry Deletion Recalculation

*For any* delivery entry deletion, the system SHALL recalculate all income totals (halal, non-halal, cash, digital) to reflect the removal of the deleted entry's amounts.

**Validates: Requirements 15.4**

### Property 30: Audit Timestamp Recording

*For any* delivery entry modification (create, update, delete), the system SHALL record an audit timestamp indicating when the modification occurred.

**Validates: Requirements 15.5**

## Error Handling

### Error Categories

The system handles four categories of errors:

1. **Validation Errors**: User input that fails business rules
2. **Authentication Errors**: Invalid credentials or expired sessions
3. **Database Errors**: Connection failures, transaction failures, constraint violations
4. **System Errors**: Unexpected failures, network issues, resource exhaustion

### Error Handling Strategy

#### Frontend Error Handling

**Validation Errors:**
- Display inline validation messages next to the relevant form field
- Use clear, specific error messages (e.g., "Restaurant name cannot be empty" rather than "Invalid input")
- Prevent form submission until validation passes
- Preserve user input to avoid data loss

**Authentication Errors:**
- Display error message on login form for invalid credentials
- Redirect to login page with appropriate message when session expires
- Show countdown warning 5 minutes before session expiration
- Automatically attempt to refresh expired sessions with refresh tokens

**Network/API Errors:**
- Display user-friendly error messages (avoid exposing technical details)
- Provide retry buttons for transient failures
- Show loading indicators during API calls
- Implement exponential backoff for automatic retries (max 3 attempts)

**Example Error Messages:**
```typescript
const ERROR_MESSAGES = {
  RESTAURANT_NAME_EMPTY: "Restaurant name cannot be empty",
  RESTAURANT_NAME_TOO_LONG: "Restaurant name must be 100 characters or less",
  FARE_AMOUNT_INVALID: "Fare amount must be a number greater than zero",
  FARE_AMOUNT_DECIMAL: "Fare amount can have at most 2 decimal places",
  CASH_AMOUNT_REQUIRED: "Cash amount is required when cash order is selected",
  FUTURE_DATE_INVALID: "Entry date cannot be in the future",
  NETWORK_ERROR: "Unable to connect. Please check your internet connection and try again.",
  SESSION_EXPIRED: "Your session has expired. Please log in again.",
  DUPLICATE_ENTRY: "This entry may be a duplicate. Please verify before saving.",
  SERVER_ERROR: "Something went wrong. Please try again later."
};
```

#### Backend Error Handling

**Validation Errors (400 Bad Request):**
```typescript
interface ValidationErrorResponse {
  error: "VALIDATION_ERROR";
  message: string;
  fields: {
    field: string;
    message: string;
  }[];
}
```

**Authentication Errors (401 Unauthorized):**
```typescript
interface AuthErrorResponse {
  error: "AUTHENTICATION_ERROR";
  message: string;
  code: "INVALID_CREDENTIALS" | "SESSION_EXPIRED" | "INVALID_TOKEN";
}
```

**Database Errors:**
- **Connection Failures**: Retry up to 3 times with exponential backoff (1s, 2s, 4s)
- **Transaction Failures**: Rollback all changes and return 500 error with generic message
- **Constraint Violations**: Return 400 error with specific constraint violation details
- **Timeout Errors**: Return 504 Gateway Timeout after 30 seconds

```typescript
class DatabaseClient {
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        if (!this.isRetryableError(error) || attempt === maxRetries) {
          throw error;
        }
        
        const delayMs = Math.pow(2, attempt) * 1000;
        await this.delay(delayMs);
      }
    }
    
    throw lastError!;
  }
  
  private isRetryableError(error: Error): boolean {
    // Connection timeout, network errors, temporary unavailability
    return error.message.includes("ECONNREFUSED") ||
           error.message.includes("ETIMEDOUT") ||
           error.message.includes("temporary");
  }
}
```

**Error Logging:**
- All errors logged to CloudWatch or equivalent with:
  - Timestamp
  - User ID (when available)
  - Request ID for tracing
  - Error type and message
  - Stack trace
  - Relevant context (API endpoint, input parameters)

**Error Response Format:**
```typescript
interface ErrorResponse {
  error: string;          // Error type constant
  message: string;        // User-friendly message
  requestId: string;      // For support tracking
  timestamp: string;      // ISO 8601 format
  details?: any;          // Additional context (dev only)
}
```

### Critical Error Scenarios

**Database Connection Loss During Session:**
1. Detect connection failure in Database Client
2. Log error with full context
3. Attempt reconnection with exponential backoff
4. If reconnection fails after 3 attempts, return 503 Service Unavailable
5. Display maintenance message to user
6. Send alert to system administrators

**Transaction Failure Mid-Operation:**
1. Catch exception in transaction block
2. Execute rollback automatically
3. Log transaction details and error
4. Return 500 error to client with generic message
5. Preserve user input in frontend for retry

**CSV Import with Partial Failures:**
1. Process CSV row by row
2. Collect all validation errors without stopping
3. Skip invalid rows and continue processing valid rows
4. Return detailed report showing:
   - Number of successful imports
   - List of failed rows with specific error messages
5. Allow user to fix errors and re-import only failed rows

**Session Expiration During Form Entry:**
1. Detect 401 error from API
2. Save form state to localStorage
3. Redirect to login page with return URL
4. After successful login, restore form state
5. Allow user to continue from where they left off

## Testing Strategy

### Overview

The testing strategy employs a multi-layered approach combining unit tests, property-based tests, integration tests, and end-to-end tests. Given that this is a web application with significant CRUD operations and database interactions, the strategy balances comprehensive coverage with practical test execution speed.

### Property-Based Testing

**Applicability Assessment:**

Property-based testing (PBT) is appropriate for this system's business logic, validation, and data transformation functions. However, many requirements involve integration concerns (database operations, authentication, UI rendering) better suited to example-based or integration tests.

**PBT Framework:** [fast-check](https://github.com/dubzzz/fast-check) for JavaScript/TypeScript

**Test Configuration:**
- Minimum 100 iterations per property test
- Each test tagged with feature name and property reference:
  ```typescript
  test("Feature: halal-or-not, Property 9: Amount Input Validation", () => {
    // Property test implementation
  });
  ```

**Property Test Coverage:**

The following correctness properties will be implemented as property-based tests:

1. **Property 1**: User Data Isolation
2. **Property 2**: Conditional Workflow Display
3. **Property 3**: Restaurant Status Categorization
4. **Property 4**: Income Aggregation Accuracy
5. **Property 5**: Payment Type Classification
6. **Property 6**: Restaurant Name Input Validation
7. **Property 7**: Restaurant Name Preservation
8. **Property 8**: Autocomplete Matching
9. **Property 9**: Amount Input Validation
10. **Property 12**: Delivery Entry Round-Trip Persistence
11. **Property 13**: Entry List Sorting
12. **Property 14**: Date Range Filtering
13. **Property 15**: Status and Payment Type Filtering
14. **Property 16**: Filtered Income Aggregation
15. **Property 17**: CSV Export Round-Trip
16. **Property 18**: Workflow Validation
17. **Property 19**: Workflow State Preservation
18. **Property 20**: SQL Injection Prevention
19. **Property 21**: Automatic Date Assignment
20. **Property 22**: Past Date Acceptance and Future Date Rejection
21. **Property 23**: Timezone Display
22. **Property 24**: CSV Import Validation
23. **Property 25**: CSV Import Data Preservation
24. **Property 26**: Duplicate Import Prevention
25. **Property 27**: Entry Edit Pre-Fill
26. **Property 28**: Entry Update Re-Categorization
27. **Property 29**: Entry Deletion Recalculation
28. **Property 30**: Audit Timestamp Recording

Properties 10 and 11 (transaction atomicity and error logging) will use mock-based property tests rather than actual database transactions.

### Unit Testing

**Framework:** Jest with React Testing Library

**Unit Test Focus:**
- Specific validation examples (empty inputs, boundary values)
- UI component rendering (button states, form displays)
- Service method behavior with specific inputs
- Error handling paths
- Edge cases not covered by property tests

**Example Unit Tests:**
```typescript
describe("IncomeService", () => {
  it("should reject entry with empty restaurant name", () => {
    const result = service.validateEntryData({
      restaurantName: "",
      restaurantStatus: "halal",
      fareAmount: 25.50,
      hasCashOrder: false
    });
    
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual({
      field: "restaurantName",
      message: "Restaurant name cannot be empty"
    });
  });
  
  it("should display Step 5 when cash order is yes", () => {
    const { getByText } = render(<EntryWorkflow />);
    
    // Navigate to Step 4
    // ... (workflow navigation code)
    
    fireEvent.click(getByText("Yes"));
    
    expect(getByText("Step 5: Cash Amount")).toBeInTheDocument();
  });
});
```

### Integration Testing

**Framework:** Jest with Supertest for API testing, Test Containers for database

**Integration Test Focus:**
- API endpoint behavior with real database (using test database)
- Authentication flow (login, session management, logout)
- Database operations (create, read, update, delete with actual DB)
- CSV import with file upload
- Multi-step workflows end-to-end

**Database Setup:**
```typescript
beforeAll(async () => {
  // Spin up test PostgreSQL container
  container = await new GenericContainer("postgres:15")
    .withEnvironment({ POSTGRES_PASSWORD: "test" })
    .withExposedPorts(5432)
    .start();
  
  // Run migrations
  await runMigrations(testDbUrl);
});

afterAll(async () => {
  await container.stop();
});
```

**Example Integration Tests:**
```typescript
describe("POST /api/income-entries", () => {
  it("should create entry and persist to database within 2 seconds", async () => {
    const startTime = Date.now();
    
    const response = await request(app)
      .post("/api/income-entries")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        restaurantName: "Test Restaurant",
        restaurantStatus: "halal",
        fareAmount: 25.50,
        hasCashOrder: false,
        entryDate: "2024-01-15"
      });
    
    const duration = Date.now() - startTime;
    
    expect(response.status).toBe(201);
    expect(duration).toBeLessThan(2000);
    
    // Verify database persistence
    const entry = await db.incomeEntry.findUnique({
      where: { id: response.body.entry.id }
    });
    
    expect(entry).toBeDefined();
    expect(entry.restaurantName).toBe("Test Restaurant");
  });
});
```

### End-to-End Testing

**Framework:** Playwright or Cypress

**E2E Test Focus:**
- Complete user workflows (login → create entry → view dashboard → logout)
- Cross-browser compatibility (Chrome, Firefox, Safari, Edge)
- Responsive design at key breakpoints (320px, 768px, 1024px, 1920px)
- Session timeout and re-authentication
- Data migration from CSV upload

**Example E2E Test:**
```typescript
test("complete delivery entry workflow", async ({ page }) => {
  // Login
  await page.goto("/login");
  await page.fill('input[name="email"]', "test@example.com");
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  
  // Navigate to new entry
  await page.click('text=New Entry');
  
  // Step 1: Restaurant name
  await page.fill('input[name="restaurantName"]', "Pizza Palace");
  await page.click('text=Next');
  
  // Step 2: Restaurant status
  await page.click('text=Halal');
  await page.click('text=Next');
  
  // Step 3: Fare amount
  await page.fill('input[name="fareAmount"]', "32.50");
  await page.click('text=Next');
  
  // Step 4: Cash order
  await page.click('text=Yes');
  await page.click('text=Next');
  
  // Step 5: Cash amount
  await page.fill('input[name="cashAmount"]', "5.00");
  await page.click('text=Save');
  
  // Verify entry appears in dashboard
  await expect(page.locator('text=Pizza Palace')).toBeVisible();
  await expect(page.locator('text=$37.50')).toBeVisible();
});
```

### Test Coverage Targets

- **Unit Test Coverage**: 80% of business logic functions
- **Integration Test Coverage**: All API endpoints and database operations
- **Property Test Coverage**: All 30 correctness properties
- **E2E Test Coverage**: Critical user paths (entry creation, viewing, editing, deletion)

### Continuous Integration

**CI Pipeline (GitHub Actions / GitLab CI):**

```yaml
name: Test Suite

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run unit tests
        run: npm run test:unit
      
      - name: Run property-based tests
        run: npm run test:property
        # Warning: PBT tests may take longer due to 100+ iterations
      
      - name: Run integration tests
        run: npm run test:integration
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/test
      
      - name: Run E2E tests
        run: npm run test:e2e
      
      - name: Upload coverage reports
        uses: codecov/codecov-action@v3
```

### Performance Testing

**Load Testing (Apache JMeter or k6):**
- Test dashboard load time under 3 seconds with 100 concurrent users
- Verify database write performance stays under 2 seconds for entry creation
- Test CSV import with files containing 1,000+ rows

**Database Query Optimization:**
- Use EXPLAIN ANALYZE for all queries in integration tests
- Set performance budgets:
  - Single entry retrieval: < 50ms
  - Filtered list query (100 entries): < 200ms
  - Aggregation query: < 500ms
  - CSV import (1000 rows): < 10 seconds

### Security Testing

**Automated Security Scans:**
- Dependency vulnerability scanning (npm audit, Snyk)
- SQL injection testing via property tests (Property 20)
- XSS prevention via input sanitization tests
- HTTPS enforcement verification
- Credential encryption verification (smoke tests)

### Manual Testing

**Accessibility Testing:**
- Keyboard navigation through entry workflow
- Screen reader compatibility (NVDA, JAWS)
- Color contrast verification (WCAG AA standards)

**Usability Testing:**
- Mobile single-handed operation
- Form completion time measurement
- Error message clarity validation

