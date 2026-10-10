-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "worker_id" VARCHAR(120) NOT NULL,
    "hostname" VARCHAR(100) NOT NULL,
    "version" VARCHAR(40) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "last_beat_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("worker_id")
);

-- CreateIndex
CREATE INDEX "worker_heartbeats_last_beat_at_idx" ON "worker_heartbeats"("last_beat_at");

