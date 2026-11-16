CREATE TABLE "environment_policies" (
	"environment_id" uuid PRIMARY KEY NOT NULL,
	"require_approval" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'Europe/Paris' NOT NULL,
	"windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environment_policies" ADD CONSTRAINT "environment_policies_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_policies" ADD CONSTRAINT "environment_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;