import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient, ReportStatus, ReportType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReportDataService } from "../src/reporting/reportDataService";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.includes("bulk_report_integration_")) {
  throw new Error("Schema integration tests require the generated disposable database.");
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const migrationRoot = "prisma/migrations";

beforeAll(async () => prisma.$connect(), 30_000);
afterAll(async () => prisma.$disconnect(), 30_000);

function runSqlFile(url: string, file: string): void {
  const result = spawnSync(
    "npx",
    ["--no-install", "prisma", "db", "execute", "--file", file, "--schema", "prisma/schema.prisma"],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to execute ${file}: ${result.stderr || result.stdout}`);
  }
}

function schemaUrl(schema: string): string {
  const url = new URL(databaseUrl as string);
  url.searchParams.set("schema", schema);
  return url.toString();
}

async function createUser(client = prisma): Promise<string> {
  const id = randomUUID();
  await client.user.create({
    data: { id, email: `${id}@example.test`, passwordHash: "integration-only" },
  });
  return id;
}

async function createRequest(userId: string, overrides: Partial<Prisma.ReportRequestUncheckedCreateInput> = {}) {
  const id = overrides.id?.toString() ?? randomUUID();
  return prisma.reportRequest.create({
    data: {
      id,
      userId,
      clientRequestId: overrides.clientRequestId?.toString() ?? randomUUID(),
      reportType: ReportType.WEEKLY,
      referenceDate: new Date("2025-01-08T00:00:00.000Z"),
      periodStart: new Date("2025-01-06T00:00:00.000Z"),
      periodEnd: new Date("2025-01-12T00:00:00.000Z"),
      accountEmail: `${userId}@example.test`,
      timeZone: "Asia/Kuala_Lumpur",
      status: ReportStatus.PENDING,
      progressStage: "data_retrieval",
      ...overrides,
    },
  });
}

describe("bulk-report PostgreSQL migration", () => {
  it("backfills legacy users and supports CI down/up verification without losing source data", async () => {
    const schema = `migration_reversal_${randomUUID().replaceAll("-", "")}`;
    const url = schemaUrl(schema);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const legacy = new PrismaClient({ datasources: { db: { url } } });

    try {
      runSqlFile(url, `${migrationRoot}/20240101000000_init/migration.sql`);
      runSqlFile(url, `${migrationRoot}/20260808094727_drop_income_tables/migration.sql`);
      await legacy.$connect();
      const userId = randomUUID();
      const entryId = randomUUID();
      await legacy.$executeRawUnsafe(
        `INSERT INTO "users" ("id", "email", "password_hash", "updated_at") VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        userId,
        `${userId}@example.test`,
        "legacy-hash",
      );
      await legacy.$executeRawUnsafe(
        `INSERT INTO "delivery_entries" ("id", "user_id", "restaurant_name", "restaurant_status", "fare_amount", "has_cash_order", "entry_date", "updated_at") VALUES ($1, $2, 'Legacy Cafe', 'halal', 12.50, false, DATE '2025-01-08', CURRENT_TIMESTAMP)`,
        entryId,
        userId,
      );

      runSqlFile(url, `${migrationRoot}/20260809000000_add_bulk_report_models/migration.sql`);
      const backfill = await legacy.$queryRawUnsafe<Array<{ time_zone: string }>>(
        `SELECT "time_zone" FROM "users" WHERE "id" = $1`,
        userId,
      );
      expect(backfill).toEqual([{ time_zone: "Asia/Kuala_Lumpur" }]);

      runSqlFile(url, `${migrationRoot}/20260809000000_add_bulk_report_models/rollback.sql`);
      const preserved = await legacy.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM "delivery_entries" WHERE "id" = $1`,
        entryId,
      );
      expect(preserved[0]?.count).toBe(1n);
      const removed = await legacy.$queryRawUnsafe<Array<{ name: string | null }>>(
        `SELECT to_regclass('"report_requests"')::text AS name`,
      );
      expect(removed[0]?.name).toBeNull();

      runSqlFile(url, `${migrationRoot}/20260809000000_add_bulk_report_models/migration.sql`);
      const reapplied = await legacy.$queryRawUnsafe<Array<{ name: string | null }>>(
        `SELECT to_regclass('"report_requests"')::text AS name`,
      );
      expect(reapplied[0]?.name).toBe("report_requests");
    } finally {
      await legacy.$disconnect();
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  }, 60_000);

  it("enforces one active request under concurrent inserts", async () => {
    const userId = await createUser();
    const attempts = await Promise.allSettled([
      createRequest(userId),
      createRequest(userId),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await prisma.reportRequest.count({ where: { userId } })).toBe(1);
  });
});

describe("bulk-report relational constraints", () => {
  it("enforces one snapshot, attachment, delivery, and job per request", async () => {
    const userId = await createUser();
    const request = await createRequest(userId);
    await prisma.reportSnapshot.create({
      data: {
        id: randomUUID(), reportRequestId: request.id, recordCount: 0,
        digitalIncomeTotal: 0, cashIncomeTotal: 0, halalIncomeTotal: 0,
        nonHalalIncomeTotal: 0,
      },
    });
    await prisma.reportAttachment.create({
      data: {
        id: randomUUID(), reportRequestId: request.id, content: Buffer.from("csv"),
        byteSize: 3, sha256: "a".repeat(64), filename: "report.csv",
        mediaType: "text/csv; charset=UTF-8", generatedAt: new Date(),
      },
    });
    await prisma.reportDelivery.create({
      data: { id: randomUUID(), reportRequestId: request.id, idempotencyKey: `report:${request.id}` },
    });
    await prisma.reportJob.create({ data: { id: randomUUID(), reportRequestId: request.id } });

    await expect(prisma.reportSnapshot.create({
      data: {
        id: randomUUID(), reportRequestId: request.id, recordCount: 0,
        digitalIncomeTotal: 0, cashIncomeTotal: 0, halalIncomeTotal: 0,
        nonHalalIncomeTotal: 0,
      },
    })).rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.reportAttachment.create({
      data: {
        id: randomUUID(), reportRequestId: request.id, content: Buffer.alloc(0),
        byteSize: 0, sha256: "b".repeat(64), filename: "empty.csv",
        mediaType: "text/csv; charset=UTF-8", generatedAt: new Date(),
      },
    })).rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.reportDelivery.create({
      data: { id: randomUUID(), reportRequestId: request.id, idempotencyKey: `report:${request.id}` },
    })).rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.reportJob.create({
      data: { id: randomUUID(), reportRequestId: request.id },
    })).rejects.toMatchObject({ code: "P2002" });
  });

  it("requires retries to reference a failed request owned by the same user", async () => {
    const ownerId = await createUser();
    const otherId = await createUser();
    const failed = await createRequest(ownerId, {
      status: ReportStatus.FAILED,
      failureStage: "SNAPSHOT",
      failureCode: "snapshot_failed",
    });
    await expect(createRequest(ownerId, { retryOfId: failed.id })).resolves.toMatchObject({ retryOfId: failed.id });

    await expect(createRequest(otherId, { retryOfId: failed.id })).rejects.toBeDefined();
    const sent = await createRequest(otherId, {
      status: ReportStatus.SENT,
      sentAt: new Date(),
    });
    await expect(createRequest(otherId, { retryOfId: sent.id })).rejects.toBeDefined();
  });

  it("deduplicates provider events and exposes the delivery selection index", async () => {
    const providerEventId = randomUUID();
    const event = {
      providerEventId,
      providerMessageId: randomUUID(),
      eventType: "email.delivered",
      occurredAt: new Date(),
      payloadDigest: "c".repeat(64),
    };
    await prisma.providerEvent.create({ data: { id: randomUUID(), ...event } });
    await expect(prisma.providerEvent.create({
      data: { id: randomUUID(), ...event, providerMessageId: randomUUID() },
    })).rejects.toMatchObject({ code: "P2002" });

    const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'delivery_entries_user_id_entry_date_idx'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef.replaceAll('"', "")).toContain("(user_id, entry_date)");
  });
});


describe("ReportDataService PostgreSQL transactions", () => {
  it("rolls back partial snapshot headers/rows and leaves source entries unchanged", async () => {
    const userId = await createUser();
    const request = await createRequest(userId);
    await prisma.deliveryEntry.createMany({
      data: [
        {
          id: randomUUID(), userId, restaurantName: "Safe Cafe", restaurantStatus: "halal",
          fareAmount: "10.25", hasCashOrder: false, cashAmount: null,
          entryDate: new Date("2025-01-07T00:00:00.000Z"),
        },
        {
          id: randomUUID(), userId, restaurantName: "FAIL SNAPSHOT", restaurantStatus: "non-halal",
          fareAmount: "20.50", hasCashOrder: true, cashAmount: "2.00",
          entryDate: new Date("2025-01-08T00:00:00.000Z"),
        },
      ],
    });
    const before = await prisma.deliveryEntry.findMany({
      where: { userId }, orderBy: { id: "asc" },
    });

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION fail_snapshot_entry_for_integration_test() RETURNS trigger AS $$
      BEGIN
        IF NEW.restaurant_name = 'FAIL SNAPSHOT' THEN
          RAISE EXCEPTION 'intentional snapshot row failure' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_snapshot_entry_for_integration_test
      BEFORE INSERT ON report_snapshot_entries
      FOR EACH ROW EXECUTE FUNCTION fail_snapshot_entry_for_integration_test()
    `);

    try {
      const service = new ReportDataService(prisma, {
        recordFailure: async () => undefined,
      });
      await expect(service.createSnapshot(
        { reportRequestId: request.id, userId },
        { recordFailure: false },
      )).rejects.toMatchObject({ code: "snapshot_failed", stage: "snapshot" });

      expect(await prisma.reportSnapshot.count({
        where: { reportRequestId: request.id },
      })).toBe(0);
      expect(await prisma.reportSnapshotEntry.count({
        where: { snapshot: { reportRequestId: request.id } },
      })).toBe(0);
      const after = await prisma.deliveryEntry.findMany({
        where: { userId }, orderBy: { id: "asc" },
      });
      expect(after).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS fail_snapshot_entry_for_integration_test ON report_snapshot_entries`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS fail_snapshot_entry_for_integration_test()`,
      );
    }
  });
});
