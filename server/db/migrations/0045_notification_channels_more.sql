ALTER TYPE "public"."notification_kind" ADD VALUE 'slack_webhook';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'discord_webhook';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'ntfy';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'gotify';--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "digest" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "digest_hour" integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "last_digest_at" timestamp with time zone;