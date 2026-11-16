ALTER TABLE "image_scans" ADD COLUMN "image_version" text;--> statement-breakpoint
ALTER TABLE "image_scans" ADD COLUMN "scan_state" text;--> statement-breakpoint
ALTER TABLE "image_scans" ADD COLUMN "scan_state_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_scans" ADD COLUMN "scan_state" text;--> statement-breakpoint
ALTER TABLE "source_scans" ADD COLUMN "scan_state_at" timestamp with time zone;