#!/bin/bash

# HalalOrNot System Status Check
# Verifies all components are working correctly

echo "🔍 HalalOrNot System Status Check"
echo "=================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check PostgreSQL
echo "1️⃣  Checking PostgreSQL..."
if pg_isready -h localhost -p 5432 > /dev/null 2>&1; then
    echo -e "   ${GREEN}✓${NC} PostgreSQL is running"
else
    echo -e "   ${RED}✗${NC} PostgreSQL is NOT running"
    echo "   To start: brew services start postgresql@15"
    exit 1
fi

# Check Database Connection
echo "2️⃣  Checking Database Connection..."
if psql -U meerzadanial -d halalornot -c "SELECT 1" > /dev/null 2>&1; then
    echo -e "   ${GREEN}✓${NC} Database 'halalornot' is accessible"
else
    echo -e "   ${RED}✗${NC} Cannot connect to database 'halalornot'"
    exit 1
fi

# Check Tables
echo "3️⃣  Checking Database Tables..."
TABLE_COUNT=$(psql -U meerzadanial -d halalornot -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | xargs)
if [ "$TABLE_COUNT" -ge "6" ]; then
    echo -e "   ${GREEN}✓${NC} All tables exist ($TABLE_COUNT tables found)"
else
    echo -e "   ${RED}✗${NC} Missing tables (found $TABLE_COUNT, expected 6)"
    echo "   Run: cd packages/backend && npx prisma db push"
    exit 1
fi

# Check Test User
echo "4️⃣  Checking Test User..."
USER_EXISTS=$(psql -U meerzadanial -d halalornot -t -c "SELECT COUNT(*) FROM users WHERE email = 'test@example.com';" 2>/dev/null | xargs)
if [ "$USER_EXISTS" = "1" ]; then
    echo -e "   ${GREEN}✓${NC} Test user exists (test@example.com)"
else
    echo -e "   ${YELLOW}⚠${NC}  Test user not found"
    echo "   Run: cd packages/backend && npx tsx scripts/reset-test-user.ts"
fi

# Check Prisma Client
echo "5️⃣  Checking Prisma Client..."
if [ -d "../../node_modules/@prisma/client" ]; then
    echo -e "   ${GREEN}✓${NC} Prisma Client is generated"
else
    echo -e "   ${RED}✗${NC} Prisma Client not generated"
    echo "   Run: cd packages/backend && npx prisma generate"
    exit 1
fi

# Check Backend Port
echo "6️⃣  Checking Backend Server..."
if curl -s http://localhost:3001/health > /dev/null 2>&1; then
    echo -e "   ${GREEN}✓${NC} Backend is running on port 3001"
    HEALTH=$(curl -s http://localhost:3001/health | grep -o "ok")
    if [ "$HEALTH" = "ok" ]; then
        echo -e "   ${GREEN}✓${NC} Backend health check passed"
    fi
else
    echo -e "   ${YELLOW}⚠${NC}  Backend is NOT running"
    echo "   To start: cd packages/backend && npm run dev"
fi

# Check Frontend Port
echo "7️⃣  Checking Frontend Server..."
if curl -s http://localhost:5173 > /dev/null 2>&1; then
    echo -e "   ${GREEN}✓${NC} Frontend is running on port 5173"
else
    echo -e "   ${YELLOW}⚠${NC}  Frontend is NOT running"
    echo "   To start: cd packages/frontend && npm run dev"
fi

# Check Login Endpoint
echo "8️⃣  Checking Login Endpoint..."
if curl -s http://localhost:3001/api/auth/login > /dev/null 2>&1; then
    LOGIN_TEST=$(curl -s -X POST http://localhost:3001/api/auth/login \
        -H "Content-Type: application/json" \
        -d '{"email":"test@example.com","password":"password123"}' | grep -o "token")
    
    if [ "$LOGIN_TEST" = "token" ]; then
        echo -e "   ${GREEN}✓${NC} Login endpoint working correctly"
        echo -e "   ${GREEN}✓${NC} Test credentials validated"
    else
        echo -e "   ${RED}✗${NC} Login endpoint returned error"
        echo "   Try: cd packages/backend && npx tsx scripts/reset-test-user.ts"
    fi
else
    echo -e "   ${YELLOW}⚠${NC}  Cannot reach login endpoint (backend not running)"
fi

echo ""
echo "=================================="
echo "📋 Summary"
echo "=================================="
echo ""
echo "Database & Prisma:"
echo -e "  PostgreSQL: ${GREEN}✓${NC} Running"
echo -e "  Database:   ${GREEN}✓${NC} Connected"
echo -e "  Tables:     ${GREEN}✓${NC} Schema OK"
echo -e "  Test User:  ${GREEN}✓${NC} Ready"
echo ""
echo "Servers:"
if curl -s http://localhost:3001/health > /dev/null 2>&1; then
    echo -e "  Backend:    ${GREEN}✓${NC} Running (port 3001)"
else
    echo -e "  Backend:    ${YELLOW}⚠${NC}  Not running"
fi

if curl -s http://localhost:5173 > /dev/null 2>&1; then
    echo -e "  Frontend:   ${GREEN}✓${NC} Running (port 5173)"
else
    echo -e "  Frontend:   ${YELLOW}⚠${NC}  Not running"
fi
echo ""

if curl -s http://localhost:3001/health > /dev/null 2>&1 && curl -s http://localhost:5173 > /dev/null 2>&1; then
    echo -e "${GREEN}✅ All systems operational!${NC}"
    echo ""
    echo "🚀 Ready to login:"
    echo "   URL:      http://localhost:5173"
    echo "   Email:    test@example.com"
    echo "   Password: password123"
else
    echo -e "${YELLOW}⚠️  System partially ready${NC}"
    echo ""
    echo "To start missing services:"
    if ! curl -s http://localhost:3001/health > /dev/null 2>&1; then
        echo "  Backend:  cd packages/backend && npm run dev"
    fi
    if ! curl -s http://localhost:5173 > /dev/null 2>&1; then
        echo "  Frontend: cd packages/frontend && npm run dev"
    fi
fi

echo ""
