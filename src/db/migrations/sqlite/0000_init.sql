CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_at` ON `events` (`at`);--> statement-breakpoint
CREATE TABLE `hosts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'online' NOT NULL,
	`last_seen_at` text NOT NULL,
	`is_leader` integer DEFAULT false NOT NULL,
	`docker_ok` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosts_name_unique` ON `hosts` (`name`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`github_job_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`name` text NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`conclusion` text,
	`runner_id` integer,
	`html_url` text DEFAULT '' NOT NULL,
	`retries` integer DEFAULT 0 NOT NULL,
	`queued_at` text NOT NULL,
	`started_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_github_job_id_unique` ON `jobs` (`github_job_id`);--> statement-breakpoint
CREATE INDEX `jobs_status_queued` ON `jobs` (`status`,`queued_at`);--> statement-breakpoint
CREATE INDEX `jobs_repo` ON `jobs` (`repo`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`full_name` text NOT NULL,
	`adopted` integer DEFAULT false NOT NULL,
	`is_private` integer DEFAULT false NOT NULL,
	`webhook_id` integer,
	`adopted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_full_name_unique` ON `repos` (`full_name`);--> statement-breakpoint
CREATE TABLE `runner_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`labels` text DEFAULT '[]' NOT NULL,
	`image` text NOT NULL,
	`cpus` real DEFAULT 1 NOT NULL,
	`memory_mb` integer DEFAULT 1024 NOT NULL,
	`mounts` text DEFAULT '[]' NOT NULL,
	`env` text DEFAULT '{}' NOT NULL,
	`secret_env` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_types_name_unique` ON `runner_types` (`name`);--> statement-breakpoint
CREATE TABLE `runners` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`type` text NOT NULL,
	`container_id` text,
	`state` text DEFAULT 'spawning' NOT NULL,
	`job_id` integer,
	`repo` text,
	`job_name` text,
	`github_runner_id` integer,
	`created_at` text NOT NULL,
	`exited_at` text
);
--> statement-breakpoint
CREATE INDEX `runners_host_state` ON `runners` (`host`,`state`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` integer NOT NULL,
	`runner_type_id` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runner_type_id`) REFERENCES `runner_types`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slots_host_type` ON `slots` (`host_id`,`runner_type_id`);