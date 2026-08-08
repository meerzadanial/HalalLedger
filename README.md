# HalalOrNot Income Tracking System

A cloud-based (pending) web application for tracking and categorizing delivery income with automatic halal/non-halal segregation.

## Project Structure

This is a monorepo containing both frontend and backend packages:

```
halalornot-monorepo/
├── packages/
│   ├── frontend/          # React + TypeScript frontend
│   │   ├── src/
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── package.json
│   └── backend/           # Node.js + Express + TypeScript backend
│       ├── src/
│       ├── prisma/
│       │   └── schema.prisma
│       └── package.json
├── .eslintrc.json         # Root ESLint config
├── .prettierrc            # Prettier config
├── tsconfig.base.json     # Base TypeScript config
└── package.json           # Root package.json with workspaces
```

## Tech Stack

### Frontend
- **Framework**: React 18 with TypeScript
- **Styling**: TailwindCSS
- **State Management**: React Query (TanStack Query)
- **Forms**: React Hook Form
- **Routing**: React Router v6
- **Build Tool**: Vite
- **Testing**: Vitest

### Backend
- **Runtime**: Node.js 18+
- **Framework**: Express.js with TypeScript
- **ORM**: Prisma
- **Database**: PostgreSQL
- **Authentication**: JWT with bcrypt
- **Validation**: Zod
- **Testing**: Vitest

### DevOps (Planned)
- **Frontend Hosting**: AWS Amplify / S3 + CloudFront
- **Backend Hosting**: AWS Lambda (serverless) / ECS Fargate
- **Database**: AWS RDS PostgreSQL (Multi-AZ)
- **Authentication**: AWS Cognito (optional)
- **CI/CD**: AWS CodePipeline / GitHub Actions

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0
- PostgreSQL (for local development)

### Installation

1. Clone the repository and install dependencies:

```bash
npm install
```

This will install dependencies for all packages in the monorepo.

### Environment Setup

#### Backend Environment Variables

1. Copy the example environment file:

```bash
cp packages/backend/.env.example packages/backend/.env
```

2. Update the following variables in `packages/backend/.env`:

```env
DATABASE_URL="postgresql://username:password@localhost:5432/halalornot?schema=public"
JWT_SECRET="your-secret-key-change-this-in-production"
JWT_EXPIRES_IN="30m"
PORT=3001
NODE_ENV="development"
CORS_ORIGIN="http://localhost:5173"
```

#### Frontend Environment Variables

1. Copy the example environment file:

```bash
cp packages/frontend/.env.example packages/frontend/.env
```

2. Update if needed (defaults should work for local development):

```env
VITE_API_URL=http://localhost:3001/api
```

### Database Setup

1. Initialize Prisma and generate the client:

```bash
cd packages/backend
npm run db:generate
```

2. Create the database tables:

```bash
npm run db:push
```

Or use migrations for production:

```bash
npm run db:migrate
```

3. (Optional) Open Prisma Studio to view your database:

```bash
npm run db:studio
```

### Development

Start both frontend and backend in development mode:

```bash
npm run dev
```

Or start them individually:

```bash
# Frontend only (http://localhost:5173)
npm run dev:frontend

# Backend only (http://localhost:3001)
npm run dev:backend
```

### Building for Production

Build both packages:

```bash
npm run build
```

Or build individually:

```bash
npm run build:frontend
npm run build:backend
```

### Testing

Run tests for all packages:

```bash
npm test
```

Or run tests for specific packages:

```bash
npm run test:frontend
npm run test:backend
```

### Code Quality

Format code with Prettier:

```bash
npm run format
```

Check formatting:

```bash
npm run format:check
```

Lint code:

```bash
npm run lint
```

## Available Scripts

### Root Level
- `npm run dev` - Start both frontend and backend
- `npm run build` - Build both packages
- `npm test` - Run all tests
- `npm run lint` - Lint all packages
- `npm run format` - Format all code with Prettier
- `npm run clean` - Remove all node_modules and dist folders

### Frontend Package
- `npm run dev --workspace=packages/frontend` - Start dev server
- `npm run build --workspace=packages/frontend` - Build for production
- `npm run preview --workspace=packages/frontend` - Preview production build
- `npm test --workspace=packages/frontend` - Run tests

### Backend Package
- `npm run dev --workspace=packages/backend` - Start dev server with watch mode
- `npm run build --workspace=packages/backend` - Compile TypeScript
- `npm run start --workspace=packages/backend` - Start production server
- `npm test --workspace=packages/backend` - Run tests
- `npm run db:generate --workspace=packages/backend` - Generate Prisma client
- `npm run db:push --workspace=packages/backend` - Push schema to database
- `npm run db:migrate --workspace=packages/backend` - Run migrations
- `npm run db:studio --workspace=packages/backend` - Open Prisma Studio

## Project Features

- ✅ Monorepo setup with npm workspaces
- ✅ TypeScript configuration for both frontend and backend
- ✅ ESLint and Prettier configured
- ✅ Environment variable management with .env files
- ✅ Core dependencies installed (React, Express, Prisma)
- ✅ Build scripts and development servers configured
- ✅ Prisma schema with database models
- ✅ Testing setup with Vitest
- ✅ TailwindCSS configured for responsive design

## Next Steps

1. Set up authentication service (JWT)
2. Implement API endpoints for income entries and categories
3. Create frontend components for the 5-step delivery entry workflow
4. Implement dashboard and filtering views
5. Add data migration service for CSV/Google Sheets import
6. Set up AWS infrastructure for deployment

## License

Private - All rights reserved
