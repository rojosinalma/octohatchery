ALTER TABLE "job_logs" ADD COLUMN "step" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "annotations" text DEFAULT '[]' NOT NULL;