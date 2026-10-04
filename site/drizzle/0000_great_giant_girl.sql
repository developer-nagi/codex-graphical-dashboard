CREATE TABLE `remote_state` (
	`slot` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`digest` text NOT NULL,
	`generated_at` text NOT NULL,
	`received_at` text NOT NULL
);
