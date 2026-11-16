CREATE TABLE "watchtower_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timing" text DEFAULT 'interval' NOT NULL,
	"interval_sec" integer DEFAULT 86400 NOT NULL,
	"schedule" text DEFAULT '0 0 4 * * *' NOT NULL,
	"cleanup" boolean DEFAULT true NOT NULL,
	"stop_timeout_sec" integer DEFAULT 30 NOT NULL,
	"hook_secret_id" uuid,
	"applied" jsonb,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watchtower_profiles" ADD CONSTRAINT "watchtower_profiles_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchtower_profiles" ADD CONSTRAINT "watchtower_profiles_hook_secret_id_secrets_id_fk" FOREIGN KEY ("hook_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watchtower_profiles_uq" ON "watchtower_profiles" USING btree ("endpoint_id","name");