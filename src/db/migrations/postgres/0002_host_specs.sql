ALTER TABLE "hosts" ADD COLUMN "cpus" integer;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "memory_mb" integer;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "os" text;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "docker_version" text;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "app_version" text;