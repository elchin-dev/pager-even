CREATE TABLE `channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`username` text NOT NULL,
	`title` text NOT NULL,
	`last_checked_at` integer,
	`last_post_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_user_username_uidx` ON `channels` (`user_id`,`username`);--> statement-breakpoint
CREATE TABLE `digest_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`channel_id` integer NOT NULL,
	`channel_title` text NOT NULL,
	`channel_username` text NOT NULL,
	`post_id` integer NOT NULL,
	`text` text NOT NULL,
	`gist` text NOT NULL,
	`published_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_posts_user_chan_post_uidx` ON `digest_posts` (`user_id`,`channel_username`,`post_id`);--> statement-breakpoint
CREATE INDEX `digest_posts_user_pub_idx` ON `digest_posts` (`user_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `digest_posts_expires_idx` ON `digest_posts` (`expires_at`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`text` text NOT NULL,
	`meeting_event_id` text,
	`meeting_title` text,
	`remind_at` integer,
	`task_completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notes_user_updated_idx` ON `notes` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `notes_remind_at_idx` ON `notes` (`remind_at`);--> statement-breakpoint
CREATE TABLE `promises` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`message_id` integer,
	`chat_id` integer NOT NULL,
	`contact_name` text NOT NULL,
	`reply_text` text NOT NULL,
	`task_text` text NOT NULL,
	`promised_at_time` text NOT NULL,
	`remind_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `promises_user_remind_idx` ON `promises` (`user_id`,`remind_at`);--> statement-breakpoint
ALTER TABLE `user_settings` ADD `meeting_reminders` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `brief_alerts` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `task_reminders` integer DEFAULT true NOT NULL;