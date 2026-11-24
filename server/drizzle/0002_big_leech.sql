ALTER TABLE `messages` ADD `is_from_owner` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `chat_view` text DEFAULT 'new_only' NOT NULL;