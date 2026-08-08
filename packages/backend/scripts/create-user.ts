/**
 * Create User Script
 *
 * Creates a user with a custom email/password for local development.
 *
 * Usage:
 *   npx tsx scripts/create-user.ts <email> <password>
 *
 * Example:
 *   npx tsx scripts/create-user.ts myself@example.com mySecret123
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const [email, password] = process.argv.slice(2);

  if (!email || !password) {
    console.error('❌ Usage: npx tsx scripts/create-user.ts <email> <password>');
    process.exit(1);
  }

  console.log('🌱 Creating user...');
  console.log(`Email: ${email}`);

  try {
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      console.log('⚠️  A user with this email already exists.');
      console.log(`   User ID: ${existingUser.id}`);
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);

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
