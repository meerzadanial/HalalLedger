-- Persist worker liveness so the API process can report cross-process readiness.
CREATE TABLE "report_worker_heartbeats" (
    "worker_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL,
    "stopped_at" TIMESTAMP(3),

    CONSTRAINT "report_worker_heartbeats_pkey" PRIMARY KEY ("worker_id"),
    CONSTRAINT "report_worker_heartbeats_worker_id_not_blank"
      CHECK (btrim("worker_id") <> ''),
    CONSTRAINT "report_worker_heartbeats_times_valid"
      CHECK (
        "last_heartbeat_at" >= "started_at" AND
        ("stopped_at" IS NULL OR "stopped_at" >= "last_heartbeat_at")
      )
);

CREATE INDEX "report_worker_heartbeats_last_heartbeat_at_idx"
ON "report_worker_heartbeats"("last_heartbeat_at");
