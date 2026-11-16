CREATE TABLE "proxy_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"domains" text[] NOT NULL,
	"subject" text NOT NULL,
	"issuer" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"fingerprint" text NOT NULL,
	"self_signed" boolean DEFAULT false NOT NULL,
	"key_type" text NOT NULL,
	"cert_pem" text NOT NULL,
	"key_secret_id" uuid NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_proxies" ADD COLUMN "applied_certificates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "proxy_certificates" ADD CONSTRAINT "proxy_certificates_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_certificates" ADD CONSTRAINT "proxy_certificates_key_secret_id_secrets_id_fk" FOREIGN KEY ("key_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_certificates" ADD CONSTRAINT "proxy_certificates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proxy_certificates_endpoint_fp" ON "proxy_certificates" USING btree ("endpoint_id","fingerprint");