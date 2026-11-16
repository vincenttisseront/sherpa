ALTER TABLE "identity_providers" ADD COLUMN "require_mapped_group" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "allowed_email_domains" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "purpose" text DEFAULT 'invite' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "csrf_token" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;