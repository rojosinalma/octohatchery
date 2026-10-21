ALTER TABLE `job_logs` ADD `step` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `annotations` text DEFAULT '[]' NOT NULL;