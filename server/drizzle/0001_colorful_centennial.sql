CREATE TABLE `user_settings` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`feed_mode` text DEFAULT 'urgent' NOT NULL,
	`voice_enabled` integer DEFAULT true NOT NULL,
	`conflict_alerts` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
