# HalalLedger Income Tracking System

A cloud-based (pending) web application for tracking and categorizing delivery income with automatic halal/non-halal segregation.

## Project Structure

This is a monorepo containing both frontend and backend packages:

```
halalledger-monorepo/
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

1.✅ ~~Set up authentication service (JWT)~~
2.✅ ~~Implement API endpoints for income entries and categories~~
3.✅ ~~Create frontend components for the 5-step delivery entry workflow~~
4.✅ ~~Implement dashboard and filtering views~~
5.✅ ~~Add data migration service for CSV/Google Sheets import~~
6. Set up AWS infrastructure for deployment

## License

Private - All rights reserved
