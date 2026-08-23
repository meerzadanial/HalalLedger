import {
  Prisma,
  PrismaClient,
  ReportStatus,
  ReportType,
} from "@prisma/client";
import { parse } from "csv-parse/sync";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REPORT_CSV_MEDIA_TYPE } from "./constants";
import { CsvReportGenerator } from "./csvReportGenerator";
import type { Clock, IdGenerator } from "./infrastructure";
import type {
  ReportAttachment,
  ReportSnapshot,
  ReportSnapshotEntry,
  ReportSummary,
} from "./models";
import type { EmailProvider, EmailProviderCommand } from "./provider";
import {
  REPORT_EMAIL_BODY_LIMIT,
  REPORT_EMAIL_SUBJECT_LIMIT,
  ReportEmailService,
} from "./reportEmailService";
import { asReportDateString, type ReportDateString } from "./temporal";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const DELIVERY_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";
const COMPLETED_AT = new Date("2035-01-01T00:00:00.000Z");
const SUBMITTED_AT = new Date("2035-01-01T00:01:00.000Z");
const ACCEPTED_AT = new Date("2035-01-01T00:01:01.000Z");
const DAY_MS = 86_400_000;
const WEEK_BASE_MS = Date.parse("2024-01-01T00:00:00.000Z");

interface GeneratedPeriod {
  readonly reportType: "weekly" | "monthly";
  readonly startDate: ReportDateString;
  readonly endDate: ReportDateString;
}

interface EntrySeed {
  readonly restaurantStatus: "halal" | "non-halal";
  readonly fareCents: number;
  readonly hasCashOrder: boolean;
  readonly cashCents: number;
  readonly dayOffset: number;
  readonly timestampOffsetSeconds: number;
}
interface GeneratedCase {
  readonly period: GeneratedPeriod;
  readonly accountLocalPart: string;
  readonly entries: readonly EntrySeed[];
}

interface Delivery {
  id: string;
  reportRequestId: string;
  idempotencyKey: string;
  providerMessageId: string | null;
  submittedAt: Date | null;
  acceptedAt: Date | null;
  deliveryDeadlineAt: Date | null;
  confirmedAt: Date | null;
}

interface RequestFixture {
  id: string;
  accountEmail: string;
  reportType: ReportType;
  periodStart: Date;
  periodEnd: Date;
  status: ReportStatus;
  sentAt: Date | null;
  snapshot: ReportSummary;
  attachment: {
    content: Buffer;
    filename: string;
    mediaType: string;
  };
  delivery: Delivery | null;
}

const periodArbitrary: fc.Arbitrary<GeneratedPeriod> = fc.oneof(
  fc.integer({ min: -250, max: 250 }).map((weekOffset) => {
    const start = new Date(WEEK_BASE_MS + weekOffset * 7 * DAY_MS);
    const end = new Date(start.getTime() + 6 * DAY_MS);
    return {
      reportType: "weekly" as const,
      startDate: reportDate(start.toISOString().slice(0, 10)),
      endDate: reportDate(end.toISOString().slice(0, 10)),
    };
  }),
  fc
    .record({
      year: fc.integer({ min: 2020, max: 2030 }),
      month: fc.integer({ min: 1, max: 12 }),
    })
    .map(({ year, month }) => ({
      reportType: "monthly" as const,
      startDate: reportDate(
        `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`,
      ),
      endDate: reportDate(
        new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
      ),
    })),
);

const localPartArbitrary = fc
  .array(
    fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    ),
    { minLength: 1, maxLength: 24 },
  )
  .map((characters) => characters.join(""));

const generatedCaseArbitrary: fc.Arbitrary<GeneratedCase> = fc.record({
  period: periodArbitrary,
  accountLocalPart: localPartArbitrary,
  entries: fc.array(
    fc.record({
      restaurantStatus: fc.constantFrom<"halal" | "non-halal">(
        "halal",
        "non-halal",
      ),
      fareCents: fc.integer({ min: 0, max: 10_000_000 }),
      hasCashOrder: fc.boolean(),
      cashCents: fc.integer({ min: 0, max: 10_000_000 }),
      dayOffset: fc.integer({ min: 0, max: 40 }),
      timestampOffsetSeconds: fc.integer({ min: 0, max: 86_399 }),
    }),
    { minLength: 0, maxLength: 10 },
  ),
});

const telemetry = { emit: () => undefined };
function reportDate(value: string): ReportDateString {
  const parsed = asReportDateString(value);
  if (parsed === null) {
    throw new Error(`Invalid generated report date: ${value}`);
  }
  return parsed;
}

function decimalFromCents(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).dividedBy(100);
}

function periodLength(period: GeneratedPeriod): number {
  const start = Date.parse(`${period.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${period.endDate}T00:00:00.000Z`);
  return Math.floor((end - start) / DAY_MS) + 1;
}

function makeEntries(input: GeneratedCase): ReportSnapshotEntry[] {
  const start = Date.parse(`${input.period.startDate}T00:00:00.000Z`);
  const days = periodLength(input.period);
  return input.entries.map((seed, index) => {
    const entryDateMs = start + (seed.dayOffset % days) * DAY_MS;
    return {
      sourceEntryId: `source-${String(index).padStart(2, "0")}`,
      restaurantName: `Restaurant ${index}`,
      restaurantStatus: seed.restaurantStatus,
      fareAmount: decimalFromCents(seed.fareCents),
      hasCashOrder: seed.hasCashOrder,
      cashAmount: decimalFromCents(seed.cashCents),
      entryDate: reportDate(new Date(entryDateMs).toISOString().slice(0, 10)),
      entryTimestamp: new Date(
        entryDateMs + seed.timestampOffsetSeconds * 1_000,
      ),
    };
  });
}

function summarize(entries: readonly ReportSnapshotEntry[]): ReportSummary {
  let digital = new Prisma.Decimal(0);
  let cash = new Prisma.Decimal(0);
  let halal = new Prisma.Decimal(0);
  let nonHalal = new Prisma.Decimal(0);
  for (const entry of entries) {
    const includedCash = entry.hasCashOrder
      ? (entry.cashAmount ?? new Prisma.Decimal(0))
      : new Prisma.Decimal(0);
    const total = entry.fareAmount.plus(includedCash);
    digital = digital.plus(entry.fareAmount);
    cash = cash.plus(includedCash);
    if (entry.restaurantStatus === "halal") {
      halal = halal.plus(total);
    } else {
      nonHalal = nonHalal.plus(total);
    }
  }
  return {
    recordCount: entries.length,
    digitalIncomeTotal: digital,
    cashIncomeTotal: cash,
    halalIncomeTotal: halal,
    nonHalalIncomeTotal: nonHalal,
  };
}

function makePersistedCase(input: GeneratedCase): {
  request: RequestFixture;
  snapshot: ReportSnapshot;
  attachment: ReportAttachment;
} {
  const entries = makeEntries(input);
  const snapshot: ReportSnapshot = {
    id: SNAPSHOT_ID,
    reportRequestId: REQUEST_ID,
    reportType: input.period.reportType,
    period: {
      startDate: input.period.startDate,
      endDate: input.period.endDate,
      inclusive: true,
    },
    createdAt: new Date("2034-12-31T23:59:00.000Z"),
    entries,
    summary: summarize(entries),
  };
  const clock: Clock = { now: () => new Date(COMPLETED_AT) };
  const attachment = new CsvReportGenerator(clock, telemetry).generate(snapshot);
  return {
    request: {
      id: REQUEST_ID,
      accountEmail: `${input.accountLocalPart}@example.com`,
      reportType:
        input.period.reportType === "weekly"
          ? ReportType.WEEKLY
          : ReportType.MONTHLY,
      periodStart: new Date(`${input.period.startDate}T00:00:00.000Z`),
      periodEnd: new Date(`${input.period.endDate}T00:00:00.000Z`),
      status: ReportStatus.PROCESSING,
      sentAt: null,
      snapshot: snapshot.summary,
      attachment: {
        content: Buffer.from(attachment.bytes),
        filename: attachment.filename,
        mediaType: attachment.mediaType,
      },
      delivery: null,
    },
    snapshot,
    attachment,
  };
}
function makeService(request: RequestFixture): {
  readonly service: ReportEmailService;
  readonly submittedCommands: EmailProviderCommand[];
} {
  const submittedCommands: EmailProviderCommand[] = [];
  const provider: EmailProvider = {
    submit: async (command) => {
      submittedCommands.push(command);
      return {
        providerMessageId: "provider-message-1",
        acceptedAt: new Date(ACCEPTED_AT),
      };
    },
    verifyWebhook: () => {
      throw new Error("not used");
    },
  };
  const reportRequest = {
    findUnique: async () => request,
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status: ReportStatus };
      data: { status?: ReportStatus; progressStage?: string };
    }) => {
      if (where.id !== request.id || where.status !== request.status) {
        return { count: 0 };
      }
      if (data.status !== undefined) {
        request.status = data.status;
      }
      return { count: 1 };
    },
  };
  const reportDelivery = {
    create: async ({
      data,
    }: {
      data: {
        id: string;
        reportRequestId: string;
        idempotencyKey: string;
        submittedAt: Date;
        deliveryDeadlineAt: Date;
      };
    }) => {
      const delivery: Delivery = {
        ...data,
        providerMessageId: null,
        acceptedAt: null,
        confirmedAt: null,
      };
      request.delivery = delivery;
      return delivery;
    },
    update: async ({ data }: { data: Partial<Delivery> }) => {
      if (request.delivery === null) {
        throw new Error("missing delivery");
      }
      Object.assign(request.delivery, data);
      return request.delivery;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { reportRequestId: string; acceptedAt: null };
      data: Partial<Delivery>;
    }) => {
      if (
        request.delivery === null ||
        where.reportRequestId !== request.id ||
        request.delivery.acceptedAt !== null
      ) {
        return { count: 0 };
      }
      Object.assign(request.delivery, data);
      return { count: 1 };
    },
    findUnique: async () => request.delivery,
  };
  const tx = { reportRequest, reportDelivery };
  const prisma = {
    ...tx,
    $transaction: async (
      callback: (client: typeof tx) => Promise<unknown>,
    ): Promise<unknown> => callback(tx),
  };
  const clock: Clock = { now: () => new Date(SUBMITTED_AT) };
  const ids: IdGenerator = { generate: () => DELIVERY_ID };
  const failureRecorder = { recordFailure: async () => undefined };
  return {
    service: new ReportEmailService(
      prisma as unknown as PrismaClient,
      provider,
      clock,
      failureRecorder,
      ids,
      telemetry,
    ),
    submittedCommands,
  };
}
const REQUIRED_LABELS = [
  "Report Type",
  "Period Start",
  "Period End",
  "Delivery Record Count",
  "Digital Income Total",
  "Cash Income Total",
  "Halal Income Total",
  "Non-Halal Income Total",
] as const;

function parseBody(body: string): Record<string, string> {
  const lines = body.split("\n");
  expect(lines).toHaveLength(REQUIRED_LABELS.length);
  const pairs = lines.map((line) => {
    const separator = line.indexOf(": ");
    expect(separator).toBeGreaterThan(0);
    return [line.slice(0, separator), line.slice(separator + 2)] as const;
  });
  expect(pairs.map(([label]) => label)).toEqual(REQUIRED_LABELS);
  return Object.fromEntries(pairs);
}

function parseCsvValues(bytes: Uint8Array): Record<string, string> {
  const csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const records = parse(csv, {
    relax_column_count: true,
    skip_empty_lines: false,
  }) as string[][];
  const values: Record<string, string> = {};
  for (const label of REQUIRED_LABELS) {
    const matches = records.filter(
      (record) => record.length === 2 && record[0] === label,
    );
    expect(matches).toHaveLength(1);
    values[label] = matches[0][1];
  }
  return values;
}

function expectedValues(
  persisted: ReturnType<typeof makePersistedCase>,
): Record<string, string> {
  const { request, snapshot } = persisted;
  return {
    "Report Type": snapshot.reportType,
    "Period Start": snapshot.period.startDate,
    "Period End": snapshot.period.endDate,
    "Delivery Record Count": String(request.snapshot.recordCount),
    "Digital Income Total": request.snapshot.digitalIncomeTotal.toFixed(2),
    "Cash Income Total": request.snapshot.cashIncomeTotal.toFixed(2),
    "Halal Income Total": request.snapshot.halalIncomeTotal.toFixed(2),
    "Non-Halal Income Total": request.snapshot.nonHalalIncomeTotal.toFixed(2),
  };
}

describe("ReportEmailService provider-command agreement", () => {
  // Feature: bulk-csv-report-email, Property 16: Email command agrees with persisted report
  // **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
  it("submits a singleton recipient and attachment whose labels agree with durable report data", async () => {
    await fc.assert(
      fc.asyncProperty(generatedCaseArbitrary, async (input) => {
        const persisted = makePersistedCase(input);
        const harness = makeService(persisted.request);

        await harness.service.submit(REQUEST_ID);

        expect(harness.submittedCommands).toHaveLength(1);
        const command = harness.submittedCommands[0];
        expect(command.to).toEqual([persisted.request.accountEmail]);
        expect(command.to).toHaveLength(1);

        expect(command).toHaveProperty("attachment");
        expect(command).not.toHaveProperty("attachments");
        expect(command.attachment.filename).toBe(
          persisted.request.attachment.filename,
        );
        expect(command.attachment.mediaType).toBe(REPORT_CSV_MEDIA_TYPE);
        expect(command.attachment.mediaType).toBe(
          persisted.request.attachment.mediaType,
        );
        expect(Buffer.from(command.attachment.bytes)).toEqual(
          persisted.request.attachment.content,
        );
        expect(Buffer.from(command.attachment.bytes)).toEqual(
          Buffer.from(persisted.attachment.bytes),
        );

        const expected = expectedValues(persisted);
        const csvValues = parseCsvValues(command.attachment.bytes);
        const bodyValues = parseBody(command.textBody);
        expect(csvValues).toEqual(expected);
        expect(bodyValues).toEqual(expected);

        const title =
          persisted.snapshot.reportType === "weekly" ? "Weekly" : "Monthly";
        expect(command.subject).toContain(title);
        expect(command.subject).toContain(persisted.snapshot.period.startDate);
        expect(command.subject).toContain(persisted.snapshot.period.endDate);
        expect(command.subject.length).toBeLessThanOrEqual(
          REPORT_EMAIL_SUBJECT_LIMIT,
        );
        expect(command.textBody.length).toBeLessThanOrEqual(
          REPORT_EMAIL_BODY_LIMIT,
        );
      }),
      { numRuns: 100 },
    );
  });
});
