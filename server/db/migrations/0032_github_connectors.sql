CREATE TABLE "github_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"api_url" text DEFAULT 'https://api.github.com' NOT NULL,
	"owner" text NOT NULL,
	"owner_type" text NOT NULL,
	"token_secret_id" uuid NOT NULL,
	"repositories" text[] DEFAULT '{}'::text[] NOT NULL,
	"registry_host" text DEFAULT 'ghcr.io' NOT NULL,
	"expiring_days" integer DEFAULT 7 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_scan_at" timestamp with time zone,
	"last_error" text,
	"snapshot" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_connectors_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "github_connectors" ADD CONSTRAINT "github_connectors_token_secret_id_secrets_id_fk" FOREIGN KEY ("token_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_connectors" ADD CONSTRAINT "github_connectors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;