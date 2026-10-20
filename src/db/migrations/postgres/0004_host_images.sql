CREATE TABLE "host_images" (
	"id" serial PRIMARY KEY NOT NULL,
	"host_id" integer NOT NULL,
	"reference" text NOT NULL,
	"digest" text,
	"size_bytes" bigint,
	"pulled_at" text,
	"seen_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_pulls" (
	"id" serial PRIMARY KEY NOT NULL,
	"host_id" integer NOT NULL,
	"reference" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"requested_by" text NOT NULL,
	"created_at" text NOT NULL,
	"finished_at" text
);
--> statement-breakpoint
ALTER TABLE "host_images" ADD CONSTRAINT "host_images_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_pulls" ADD CONSTRAINT "image_pulls_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "host_images_host_reference" ON "host_images" USING btree ("host_id","reference");--> statement-breakpoint
CREATE INDEX "image_pulls_host_status" ON "image_pulls" USING btree ("host_id","status");