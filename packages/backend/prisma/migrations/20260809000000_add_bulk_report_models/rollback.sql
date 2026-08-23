-- CI-only reversal for the bulk-report migration.
-- Run only against a disposable PostgreSQL database/schema.
DROP INDEX IF EXISTS "delivery_entries_user_id_entry_date_idx";

DROP TABLE IF EXISTS "report_snapshot_entries";
DROP TABLE IF EXISTS "report_attachments";
DROP TABLE IF EXISTS "report_deliveries";
DROP TABLE IF EXISTS "provider_events";
DROP TABLE IF EXISTS "report_jobs";
DROP TABLE IF EXISTS "report_snapshots";
DROP TABLE IF EXISTS "report_requests";

DROP FUNCTION IF EXISTS "reject_report_artifact_update"();
DROP FUNCTION IF EXISTS "enforce_report_request_immutability"();
DROP FUNCTION IF EXISTS "enforce_report_retry_target"();

DROP TYPE IF EXISTS "ReportFailureStage";
DROP TYPE IF EXISTS "ReportStatus";
DROP TYPE IF EXISTS "ReportType";

ALTER TABLE "users" DROP COLUMN IF EXISTS "time_zone";
