/**
 * Seed User Script
 * 
 * Creates a test user in the database for local development
 * 
 * Usage:
 *   npx tsx scripts/seed-user.ts
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const email = 'test@example.com';
  const password = 'password123';

  console.log('🌱 Seeding test user...');
  console.log(`Email: ${email}`);
  console.log(`Password: ${password}`);

  try {
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      console.log('⚠️  User already exists!');
      console.log('\n✅ Login Credentials:');
      console.log(`   Email: ${email}`);
      console.log(`   Password: ${password}`);
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
      },
    });

    console.log('✅ User created successfully!');
    console.log(`   User ID: ${user.id}`);
    console.log('\n📝 Login Credentials:');
    console.log(`   Email: ${email}`);
    console.log(`   Password: ${password}`);
    console.log('\n🚀 You can now login to the application!');
  } catch (error) {
    console.error('❌ Error creating user:', error);
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
