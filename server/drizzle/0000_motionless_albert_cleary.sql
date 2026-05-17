CREATE TABLE `author` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`platform_id` text NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `clips` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`original_post_id` integer,
	`file_name` text NOT NULL,
	`clip_url` text NOT NULL,
	`thumbnail_url` text,
	`start_time` real,
	`end_time` real,
	`duration` text,
	`title` text,
	`size` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`original_post_id`) REFERENCES `original_post`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `original_post` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` integer,
	`platform` text NOT NULL,
	`post_url` text NOT NULL,
	`title` text,
	`description` text,
	`subtitles_json` text,
	`cover_image_url` text,
	`published_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `author`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `shots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`clip_id` integer,
	`idx` integer NOT NULL,
	`clip_url` text,
	`thumbnail_url` text,
	`size` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`clip_id`) REFERENCES `clips`(`id`) ON UPDATE no action ON DELETE no action
);
