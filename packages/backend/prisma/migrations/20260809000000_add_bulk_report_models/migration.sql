-- Add the authoritative account timezone while preserving and backfilling existing users.
ALTER TABLE "users"
ADD COLUMN "time_zone" TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur';

ALTER TABLE "users"
ADD CONSTRAINT "users_time_zone_not_blank" CHECK (btrim("time_zone") <> '');

-- Report lifecycle enums.
CREATE TYPE "ReportType" AS ENUM ('WEEKLY', 'MONTHLY');
CREATE TYPE "ReportStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'EMAIL_SUBMITTED',
    'EMAIL_ACCEPTED',
    'SENT',
    'FAILED'
);
CREATE TYPE "ReportFailureStage" AS ENUM (
    'DATA_RETRIEVAL',
    'SNAPSHOT',
    'CSV_GENERATION',
    'REPORT_SIZE',
    'EMAIL_SUBMISSION',
    'UNEXPECTED'
);

-- One immutable report attempt. Server-derived recipient, timezone, and dates are copied here.
CREATE TABLE "report_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "retry_of_id" TEXT,
    "report_type" "ReportType" NOT NULL,
    "reference_date" DATE NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "account_email" TEXT NOT NULL,
    "time_zone" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "progress_stage" TEXT NOT NULL,
    "failure_stage" "ReportFailureStage",
    "failure_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "report_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "report_requests_identity_not_blank" CHECK (
        btrim("client_request_id") <> '' AND
        btrim("account_email") <> '' AND
        btrim("time_zone") <> ''
    ),
    CONSTRAINT "report_requests_reference_date_supported" CHECK (
        "reference_date" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    ),
    CONSTRAINT "report_requests_period_valid" CHECK (
        "period_start" <= "reference_date" AND
        "reference_date" <= "period_end" AND
        (
            (
                "report_type" = 'WEEKLY' AND
                "period_end" = "period_start" + 6 AND
                EXTRACT(ISODOW FROM "period_start") = 1 AND
                EXTRACT(ISODOW FROM "period_end") = 7
            ) OR
            (
                "report_type" = 'MONTHLY' AND
                "period_start" = date_trunc('month', "reference_date")::date AND
                "period_end" = (date_trunc('month', "reference_date") + INTERVAL '1 month - 1 day')::date
            )
        )
    ),
    CONSTRAINT "report_requests_progress_stage_valid" CHECK (
        "progress_stage" IN ('data_retrieval', 'snapshot', 'csv_generation', 'email_submission', 'delivery_wait')
    ),
    CONSTRAINT "report_requests_failure_fields_consistent" CHECK (
        ("status" = 'FAILED') = ("failure_stage" IS NOT NULL AND "failure_code" IS NOT NULL)
        AND ("failure_code" IS NULL OR btrim("failure_code") <> '')
    ),
    CONSTRAINT "report_requests_sent_at_consistent" CHECK (
        ("status" = 'SENT') = ("sent_at" IS NOT NULL)
    ),
    CONSTRAINT "report_requests_retry_not_self" CHECK ("retry_of_id" IS NULL OR "retry_of_id" <> "id")
);

-- Immutable snapshot header and copied detail values. No foreign key points back to mutable entries.
CREATE TABLE "report_snapshots" (
    "id" TEXT NOT NULL,
    "report_request_id" TEXT NOT NULL,
    "record_count" INTEGER NOT NULL,
    "digital_income_total" DECIMAL(14,2) NOT NULL,
    "cash_income_total" DECIMAL(14,2) NOT NULL,
    "halal_income_total" DECIMAL(14,2) NOT NULL,
    "non_halal_income_total" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "report_snapshots_record_count_nonnegative" CHECK ("record_count" >= 0)
);

CREATE TABLE "report_snapshot_entries" (
    "id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "source_entry_id" TEXT NOT NULL,
    "restaurant_name" TEXT NOT NULL,
    "restaurant_status" TEXT NOT NULL,
    "fare_amount" DECIMAL(12,2) NOT NULL,
    "has_cash_order" BOOLEAN NOT NULL,
    "cash_amount" DECIMAL(12,2),
    "entry_date" DATE NOT NULL,
    "entry_timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_snapshot_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "report_snapshot_entries_source_id_not_blank" CHECK (btrim("source_entry_id") <> '')
);

CREATE TABLE "report_attachments" (
    "id" TEXT NOT NULL,
    "report_request_id" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "report_attachments_byte_size_matches" CHECK ("byte_size" = octet_length("content")),
    CONSTRAINT "report_attachments_sha256_valid" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "report_attachments_filename_not_blank" CHECK (btrim("filename") <> ''),
    CONSTRAINT "report_attachments_media_type_valid" CHECK ("media_type" = 'text/csv; charset=UTF-8')
);

-- One logical provider submission per report request.
CREATE TABLE "report_deliveries" (
    "id" TEXT NOT NULL,
    "report_request_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "delivery_deadline_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "report_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "report_deliveries_idempotency_key_matches" CHECK (
        "idempotency_key" = 'report:' || "report_request_id"
    ),
    CONSTRAINT "report_deliveries_submission_fields_consistent" CHECK (
        (
            "submitted_at" IS NULL AND
            "delivery_deadline_at" IS NULL AND
            "provider_message_id" IS NULL AND
            "accepted_at" IS NULL AND
            "confirmed_at" IS NULL
        ) OR (
            "submitted_at" IS NOT NULL AND
            "delivery_deadline_at" = "submitted_at" + INTERVAL '300 seconds' AND
            ("accepted_at" IS NULL OR "accepted_at" >= "submitted_at") AND
            (("provider_message_id" IS NULL) = ("accepted_at" IS NULL)) AND
            ("confirmed_at" IS NULL OR ("accepted_at" IS NOT NULL AND "confirmed_at" >= "accepted_at"))
        )
    ),
    CONSTRAINT "report_deliveries_provider_message_id_not_blank" CHECK (
        "provider_message_id" IS NULL OR btrim("provider_message_id") <> ''
    )
);

CREATE TABLE "provider_events" (
    "id" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload_digest" TEXT NOT NULL,

    CONSTRAINT "provider_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provider_events_values_not_blank" CHECK (
        btrim("provider_event_id") <> '' AND
        btrim("provider_message_id") <> '' AND
        btrim("event_type") <> ''
    ),
    CONSTRAINT "provider_events_payload_digest_valid" CHECK ("payload_digest" ~ '^[0-9a-f]{64}$')
);

-- Durable outbox job with cooperative lease and bounded attempt metadata.
CREATE TABLE "report_jobs" (
    "id" TEXT NOT NULL,
    "report_request_id" TEXT NOT NULL,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "last_error_code" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "report_jobs_attempts_valid" CHECK (
        "attempt_count" >= 0 AND "max_attempts" > 0 AND "attempt_count" <= "max_attempts"
    ),
    CONSTRAINT "report_jobs_lease_consistent" CHECK (
        ("lease_owner" IS NULL) = ("lease_expires_at" IS NULL) AND
        ("lease_owner" IS NULL OR btrim("lease_owner") <> '') AND
        ("completed_at" IS NULL OR "lease_owner" IS NULL)
    ),
    CONSTRAINT "report_jobs_last_error_not_blank" CHECK (
        "last_error_code" IS NULL OR btrim("last_error_code") <> ''
    )
);

-- Request identity, retry, ownership, and active-request indexes.
CREATE UNIQUE INDEX "report_requests_user_id_client_request_id_key"
ON "report_requests"("user_id", "client_request_id");
CREATE UNIQUE INDEX "report_requests_id_user_id_key"
ON "report_requests"("id", "user_id");
CREATE INDEX "report_requests_user_id_created_at_idx"
ON "report_requests"("user_id", "created_at");
CREATE INDEX "report_requests_retry_of_id_idx"
ON "report_requests"("retry_of_id");
CREATE UNIQUE INDEX "report_requests_one_active_per_user_idx"
ON "report_requests"("user_id")
WHERE "status" NOT IN ('SENT', 'FAILED');

-- One artifact/delivery/job per request and deterministic snapshot ordering.
CREATE UNIQUE INDEX "report_snapshots_report_request_id_key"
ON "report_snapshots"("report_request_id");
CREATE UNIQUE INDEX "report_snapshot_entries_snapshot_id_source_entry_id_key"
ON "report_snapshot_entries"("snapshot_id", "source_entry_id");
CREATE INDEX "report_snapshot_entries_snapshot_id_entry_date_entry_timestamp_source_entry_id_idx"
ON "report_snapshot_entries"("snapshot_id", "entry_date", "entry_timestamp", "source_entry_id");
CREATE UNIQUE INDEX "report_attachments_report_request_id_key"
ON "report_attachments"("report_request_id");
CREATE UNIQUE INDEX "report_deliveries_report_request_id_key"
ON "report_deliveries"("report_request_id");
CREATE UNIQUE INDEX "report_deliveries_idempotency_key_key"
ON "report_deliveries"("idempotency_key");
CREATE UNIQUE INDEX "report_deliveries_provider_message_id_key"
ON "report_deliveries"("provider_message_id");
CREATE INDEX "report_deliveries_delivery_deadline_at_idx"
ON "report_deliveries"("delivery_deadline_at");
CREATE UNIQUE INDEX "provider_events_provider_event_id_key"
ON "provider_events"("provider_event_id");
CREATE INDEX "provider_events_provider_message_id_idx"
ON "provider_events"("provider_message_id");
CREATE UNIQUE INDEX "report_jobs_report_request_id_key"
ON "report_jobs"("report_request_id");
CREATE INDEX "report_jobs_completed_at_available_at_idx"
ON "report_jobs"("completed_at", "available_at");
CREATE INDEX "report_jobs_lease_expires_at_idx"
ON "report_jobs"("lease_expires_at");

-- Exact report selection index required independently of dashboard indexes.
CREATE INDEX "delivery_entries_user_id_entry_date_idx"
ON "delivery_entries"("user_id", "entry_date");

-- Cascading ownership/artifact relationships; retries remain same-user and cannot dangle.
ALTER TABLE "report_requests"
ADD CONSTRAINT "report_requests_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_requests"
ADD CONSTRAINT "report_requests_retry_of_id_user_id_fkey"
FOREIGN KEY ("retry_of_id", "user_id") REFERENCES "report_requests"("id", "user_id")
ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "report_snapshots"
ADD CONSTRAINT "report_snapshots_report_request_id_fkey"
FOREIGN KEY ("report_request_id") REFERENCES "report_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_snapshot_entries"
ADD CONSTRAINT "report_snapshot_entries_snapshot_id_fkey"
FOREIGN KEY ("snapshot_id") REFERENCES "report_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_attachments"
ADD CONSTRAINT "report_attachments_report_request_id_fkey"
FOREIGN KEY ("report_request_id") REFERENCES "report_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_deliveries"
ADD CONSTRAINT "report_deliveries_report_request_id_fkey"
FOREIGN KEY ("report_request_id") REFERENCES "report_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_jobs"
ADD CONSTRAINT "report_jobs_report_request_id_fkey"
FOREIGN KEY ("report_request_id") REFERENCES "report_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Retries must link to an already-failed request owned by the same user.
CREATE FUNCTION "enforce_report_retry_target"() RETURNS trigger AS $$
DECLARE
    target_status "ReportStatus";
BEGIN
    IF NEW."retry_of_id" IS NOT NULL THEN
        SELECT "status" INTO target_status
        FROM "report_requests"
        WHERE "id" = NEW."retry_of_id" AND "user_id" = NEW."user_id";

        IF NOT FOUND OR target_status <> 'FAILED' THEN
            RAISE EXCEPTION 'retry target must be a failed request owned by the same user'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "report_requests_retry_target_check"
BEFORE INSERT OR UPDATE OF "retry_of_id", "user_id" ON "report_requests"
FOR EACH ROW EXECUTE FUNCTION "enforce_report_retry_target"();

-- Terminal attempts cannot be reopened, and immutable request identity/retry fields cannot be rewritten.
CREATE FUNCTION "enforce_report_request_immutability"() RETURNS trigger AS $$
BEGIN
    IF OLD."status" IN ('SENT', 'FAILED') AND NEW."status" <> OLD."status" THEN
        RAISE EXCEPTION 'terminal report requests cannot transition'
            USING ERRCODE = '23514';
    END IF;
    IF NEW."user_id" <> OLD."user_id"
       OR NEW."client_request_id" <> OLD."client_request_id"
       OR NEW."retry_of_id" IS DISTINCT FROM OLD."retry_of_id"
       OR NEW."report_type" <> OLD."report_type"
       OR NEW."reference_date" <> OLD."reference_date"
       OR NEW."period_start" <> OLD."period_start"
       OR NEW."period_end" <> OLD."period_end"
       OR NEW."account_email" <> OLD."account_email"
       OR NEW."time_zone" <> OLD."time_zone" THEN
        RAISE EXCEPTION 'report request identity and selection are immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "report_requests_immutable_fields_check"
BEFORE UPDATE ON "report_requests"
FOR EACH ROW EXECUTE FUNCTION "enforce_report_request_immutability"();

-- Snapshot rows and generated attachments are append-only; cascaded/retention deletes remain possible.
CREATE FUNCTION "reject_report_artifact_update"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'report snapshots and attachments are immutable'
        USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "report_snapshots_no_update"
BEFORE UPDATE ON "report_snapshots"
FOR EACH ROW EXECUTE FUNCTION "reject_report_artifact_update"();
CREATE TRIGGER "report_snapshot_entries_no_update"
BEFORE UPDATE ON "report_snapshot_entries"
FOR EACH ROW EXECUTE FUNCTION "reject_report_artifact_update"();
CREATE TRIGGER "report_attachments_no_update"
BEFORE UPDATE ON "report_attachments"
FOR EACH ROW EXECUTE FUNCTION "reject_report_artifact_update"();