ALTER TABLE "image_scans" ADD COLUMN "trigger" text;--> statement-breakpoint
ALTER TABLE "image_scans" ADD COLUMN "deployment_id" uuid;--> statement-breakpoint
ALTER TABLE "source_scans" ADD COLUMN "trigger" text;--> statement-breakpoint
ALTER TABLE "source_scans" ADD COLUMN "deployment_id" uuid;