/**
 * Reset Test User Script
 * 
 * Deletes and recreates the test user with correct password
 * 
 * Usage:
 *   npx tsx scripts/reset-test-user.ts
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const email = 'test@example.com';
  const password = 'password123';

  console.log('🔄 Resetting test user...');
  console.log(`Email: ${email}`);

  try {
    // Delete existing user
    await prisma.user.deleteMany({
      where: { email },
    });
    console.log('✅ Deleted existing user (if any)');

    // Hash password with bcrypt (rounds: 10)
    const passwordHash = await bcrypt.hash(password, 10);
    console.log('✅ Password hashed');

    // Create new user
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
      },
    });

    console.log('✅ User created successfully!');
    console.log(`   User ID: ${user.id}`);
    console.log(`   Email: ${user.email}`);
    console.log('\n📝 Login Credentials:');
    console.log(`   Email: ${email}`);
    console.log(`   Password: ${password}`);
    console.log('\n🚀 You can now login to the application!');
    console.log('   1. Make sure backend is running: npm run dev');
    console.log('   2. Make sure frontend is running: npm run dev');
    console.log('   3. Go to http://localhost:5173');
    console.log('   4. Login with the credentials above');
  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
