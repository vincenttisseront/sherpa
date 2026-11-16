ALTER TABLE "project_targets" ADD COLUMN "stack_name" text;--> statement-breakpoint
ALTER TABLE "project_targets" ADD COLUMN "auto_rollback" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_targets" ADD COLUMN "health_timeout_sec" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_targets" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "compose_path" text;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "compose_diff" text;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "analysis" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_targets" ADD CONSTRAINT "project_targets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;