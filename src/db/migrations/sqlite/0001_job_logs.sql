CREATE TABLE `job_logs` (
	`job_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`at` text NOT NULL,
	`line` text NOT NULL,
	PRIMARY KEY(`job_id`, `seq`),
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `log_source` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `log_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `log_truncated` integer DEFAULT false NOT NULL;