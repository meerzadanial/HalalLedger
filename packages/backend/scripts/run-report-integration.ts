import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const sourceUrl = process.env.REPORT_INTEGRATION_DATABASE_URL;
if (sourceUrl === undefined || sourceUrl.trim() === "") {
  console.log(
    "SKIP PostgreSQL report integration: REPORT_INTEGRATION_DATABASE_URL is not set; DATABASE_URL was not used.",
  );
  process.exit(0);
}

const adminUrl = new URL(sourceUrl);
if (adminUrl.protocol !== "postgresql:" && adminUrl.protocol !== "postgres:") {
  throw new Error("REPORT_INTEGRATION_DATABASE_URL must be a PostgreSQL URL.");
}

adminUrl.searchParams.set("schema", "public");
const databaseName = `bulk_report_integration_${Date.now()}_${randomBytes(4).toString("hex")}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
databaseUrl.searchParams.set("schema", "public");

const admin = new PrismaClient({
  datasources: { db: { url: adminUrl.toString() } },
});

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "no status"}`);
  }
}

async function main(): Promise<void> {
  await admin.$connect();
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    const env = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl.toString(),
    };
    run("npx", ["--no-install", "prisma", "migrate", "deploy"], env);
    // Run delivery read-path coverage alone so its complete-table invariance
    // snapshots cannot overlap another integration suite's fixture writes.
    run(
      "npx",
      [
        "--no-install",
        "vitest",
        "run",
        "integration/dailyIncomeReadPath.integration.test.ts",
      ],
      env,
    );
    run(
      "npx",
      [
        "--no-install",
        "vitest",
        "run",
        "integration/reportSchema.integration.test.ts",
        "integration/reportDataService.integration.test.ts",
        "integration/reportRequestApi.integration.test.ts",
      ],
      env,
    );
    // Run worker/outbox and full lifecycle coverage separately because they
    // deliberately clear the generated database between cases for isolation.
    run(
      "npx",
      [
        "--no-install",
        "vitest",
        "run",
        "integration/reportWorker.integration.test.ts",
        "integration/reportLifecycle.integration.test.ts",
      ],
      env,
    );
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
