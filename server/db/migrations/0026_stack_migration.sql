ALTER TYPE "public"."deployment_action" ADD VALUE 'migrate';--> statement-breakpoint
ALTER TABLE "project_targets" ADD COLUMN "migrated_from" jsonb;