CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"detail" text DEFAULT '{}' NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	"last_seen_at" text NOT NULL,
	"is_leader" boolean DEFAULT false NOT NULL,
	"docker_ok" boolean DEFAULT false NOT NULL,
	CONSTRAINT "hosts_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"github_job_id" bigint NOT NULL,
	"run_id" bigint NOT NULL,
	"name" text NOT NULL,
	"labels" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"conclusion" text,
	"runner_id" integer,
	"html_url" text DEFAULT '' NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"queued_at" text NOT NULL,
	"started_at" text,
	"completed_at" text,
	CONSTRAINT "jobs_github_job_id_unique" UNIQUE("github_job_id")
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"adopted" boolean DEFAULT false NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"webhook_id" bigint,
	"adopted_at" text,
	CONSTRAINT "repos_full_name_unique" UNIQUE("full_name")
);
--> statement-breakpoint
CREATE TABLE "runner_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"labels" text DEFAULT '[]' NOT NULL,
	"image" text NOT NULL,
	"cpus" real DEFAULT 1 NOT NULL,
	"memory_mb" integer DEFAULT 1024 NOT NULL,
	"mounts" text DEFAULT '[]' NOT NULL,
	"env" text DEFAULT '{}' NOT NULL,
	"secret_env" text DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "runner_types_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"type" text NOT NULL,
	"container_id" text,
	"state" text DEFAULT 'spawning' NOT NULL,
	"job_id" integer,
	"repo" text,
	"job_name" text,
	"github_runner_id" bigint,
	"created_at" text NOT NULL,
	"exited_at" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slots" (
	"id" serial PRIMARY KEY NOT NULL,
	"host_id" integer NOT NULL,
	"runner_type_id" integer NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_runner_type_id_runner_types_id_fk" FOREIGN KEY ("runner_type_id") REFERENCES "public"."runner_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_at" ON "events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "jobs_status_queued" ON "jobs" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "jobs_repo" ON "jobs" USING btree ("repo");--> statement-breakpoint
CREATE INDEX "runners_host_state" ON "runners" USING btree ("host","state");--> statement-breakpoint
CREATE UNIQUE INDEX "slots_host_type" ON "slots" USING btree ("host_id","runner_type_id");