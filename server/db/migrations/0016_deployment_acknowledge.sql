ALTER TABLE "deployments" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "acknowledged_by" uuid;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;