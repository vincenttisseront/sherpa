ALTER TABLE "proxy_certificates" ADD COLUMN "source" text DEFAULT 'imported' NOT NULL;--> statement-breakpoint
ALTER TABLE "traefik_configs" ADD COLUMN "nginx_certs_dir" text DEFAULT '/etc/nginx/platform-certs' NOT NULL;--> statement-breakpoint
ALTER TABLE "traefik_configs" ADD COLUMN "nginx_acme_email" text;--> statement-breakpoint
ALTER TABLE "traefik_configs" ADD COLUMN "nginx_acme_directory" text DEFAULT 'letsencrypt' NOT NULL;--> statement-breakpoint
ALTER TABLE "traefik_configs" ADD COLUMN "nginx_acme_account_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "traefik_configs" ADD CONSTRAINT "traefik_configs_nginx_acme_account_secret_id_secrets_id_fk" FOREIGN KEY ("nginx_acme_account_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;