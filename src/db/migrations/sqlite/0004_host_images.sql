CREATE TABLE `host_images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` integer NOT NULL,
	`reference` text NOT NULL,
	`digest` text,
	`size_bytes` integer,
	`pulled_at` text,
	`seen_at` text NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_images_host_reference` ON `host_images` (`host_id`,`reference`);--> statement-breakpoint
CREATE TABLE `image_pulls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` integer NOT NULL,
	`reference` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`requested_by` text NOT NULL,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `image_pulls_host_status` ON `image_pulls` (`host_id`,`status`);