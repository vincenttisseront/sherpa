CREATE TABLE "managed_proxies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"dns_env_secret_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"applied_config" jsonb,
	"applied_at" timestamp with time zone,
	"last_error" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_proxies_endpoint_id_unique" UNIQUE("endpoint_id")
);
--> statement-breakpoint
ALTER TABLE "project_targets" ADD COLUMN "project_path" text;--> statement-breakpoint
ALTER TABLE "project_targets" ADD COLUMN "volumes_as_folders" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_targets" ADD COLUMN "proxy_network" text;--> statement-breakpoint
ALTER TABLE "managed_proxies" ADD CONSTRAINT "managed_proxies_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_proxies" ADD CONSTRAINT "managed_proxies_dns_env_secret_id_secrets_id_fk" FOREIGN KEY ("dns_env_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_proxies" ADD CONSTRAINT "managed_proxies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;