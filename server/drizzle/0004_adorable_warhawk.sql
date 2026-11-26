CREATE TABLE `sent_reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`source_key` text NOT NULL,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sent_reminders_user_kind_key_uidx` ON `sent_reminders` (`user_id`,`kind`,`source_key`);