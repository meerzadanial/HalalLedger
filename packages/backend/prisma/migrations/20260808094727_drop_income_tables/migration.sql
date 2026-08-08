/*
  Warnings:

  - You are about to drop the `income_categories` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `income_entries` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "income_categories" DROP CONSTRAINT "income_categories_user_id_fkey";

-- DropForeignKey
ALTER TABLE "income_entries" DROP CONSTRAINT "income_entries_category_id_fkey";

-- DropForeignKey
ALTER TABLE "income_entries" DROP CONSTRAINT "income_entries_user_id_fkey";

-- DropTable
DROP TABLE "income_categories";

-- DropTable
DROP TABLE "income_entries";

-- CreateTable
CREATE TABLE "delivery_entries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "restaurant_name" TEXT NOT NULL,
    "restaurant_status" TEXT NOT NULL,
    "fare_amount" DECIMAL(12,2) NOT NULL,
    "has_cash_order" BOOLEAN NOT NULL,
    "cash_amount" DECIMAL(12,2),
    "entry_date" DATE NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_entries_user_id_idx" ON "delivery_entries"("user_id");

-- CreateIndex
CREATE INDEX "delivery_entries_entry_date_idx" ON "delivery_entries"("entry_date");

-- CreateIndex
CREATE INDEX "delivery_entries_restaurant_status_idx" ON "delivery_entries"("restaurant_status");

-- CreateIndex
CREATE INDEX "delivery_entries_created_at_idx" ON "delivery_entries"("created_at");

-- CreateIndex
CREATE INDEX "delivery_entries_user_id_entry_date_restaurant_name_fare_am_idx" ON "delivery_entries"("user_id", "entry_date", "restaurant_name", "fare_amount");

-- AddForeignKey
ALTER TABLE "delivery_entries" ADD CONSTRAINT "delivery_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
