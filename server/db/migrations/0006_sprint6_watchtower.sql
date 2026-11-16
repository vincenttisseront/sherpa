CREATE TYPE "public"."image_update_kind" AS ENUM('updated', 'available', 'failed', 'external');--> statement-breakpoint
CREATE TABLE "image_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"service" text NOT NULL,
	"image" text NOT NULL,
	"kind" "image_update_kind" NOT NULL,
	"from_image_id" text,
	"to_image_id" text,
	"digest" text,
	"release_id" uuid,
	"detail" text,
	"detected_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_targets" ADD COLUMN "watchtower_applied" jsonb;--> statement-breakpoint
ALTER TABLE "project_targets" ADD COLUMN "watchtower_hook_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "project_targets" ADD COLUMN "watchtower_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_targets" ADD COLUMN "observed_images" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "image_updates" ADD CONSTRAINT "image_updates_target_id_project_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."project_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_updates" ADD CONSTRAINT "image_updates_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_updates_target_idx" ON "image_updates" USING btree ("target_id","detected_at");--> statement-breakpoint
ALTER TABLE "project_targets" ADD CONSTRAINT "project_targets_watchtower_hook_secret_id_secrets_id_fk" FOREIGN KEY ("watchtower_hook_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;