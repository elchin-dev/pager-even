CREATE TABLE `actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ai_settings` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'server' NOT NULL,
	`provider` text DEFAULT 'anthropic' NOT NULL,
	`model` text NOT NULL,
	`key_enc` text,
	`key_last4` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `google_accounts` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`email` text,
	`refresh_token_enc` text NOT NULL,
	`scope` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `link_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`purpose` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`tg_message_id` integer NOT NULL,
	`from_tg_user_id` integer,
	`from_name` text NOT NULL,
	`business_connection_id` text,
	`text` text NOT NULL,
	`received_at` integer NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`ai_json` text,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_user_chat_msg_uidx` ON `messages` (`user_id`,`chat_id`,`tg_message_id`);--> statement-breakpoint
CREATE INDEX `messages_user_status_idx` ON `messages` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `messages_expires_at_idx` ON `messages` (`expires_at`);--> statement-breakpoint
CREATE TABLE `pair_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`pair_id` text NOT NULL,
	`user_id` integer,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pair_codes_pair_id_unique` ON `pair_codes` (`pair_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tg_user_id` integer NOT NULL,
	`tg_name` text,
	`business_connection_id` text,
	`can_reply` integer DEFAULT false NOT NULL,
	`is_enabled` integer DEFAULT false NOT NULL,
	`business_rights_json` text,
	`tz` text DEFAULT 'UTC' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_tg_user_id_unique` ON `users` (`tg_user_id`);--> statement-breakpoint
CREATE INDEX `users_business_connection_idx` ON `users` (`business_connection_id`);