CREATE TABLE "dns_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"zones" text[] DEFAULT '{}'::text[] NOT NULL,
	"wildcard" boolean DEFAULT true NOT NULL,
	"secret_id" uuid NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dns_accounts_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "dns_accounts" ADD CONSTRAINT "dns_accounts_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_accounts" ADD CONSTRAINT "dns_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;