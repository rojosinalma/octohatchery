CREATE TABLE "job_logs" (
	"job_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"at" text NOT NULL,
	"line" text NOT NULL,
	CONSTRAINT "job_logs_job_id_seq_pk" PRIMARY KEY("job_id","seq")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "log_source" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "log_bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "log_truncated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;