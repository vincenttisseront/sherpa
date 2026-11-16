ALTER TABLE "traefik_configs" ADD COLUMN "provider" text DEFAULT 'traefik' NOT NULL;--> statement-breakpoint
ALTER TABLE "traefik_configs" ADD COLUMN "letsencrypt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "traefik_configs" ADD COLUMN "nginx_container" text;--> statement-breakpoint
ALTER TABLE "traefik_configs" ADD COLUMN "nginx_conf_dir" text DEFAULT '/etc/nginx/conf.d' NOT NULL;--> statement-breakpoint
ALTER TABLE "traefik_configs" ADD COLUMN "nginx_ssl_certificate" text;--> statement-breakpoint
ALTER TABLE "traefik_configs" ADD COLUMN "nginx_ssl_certificate_key" text;