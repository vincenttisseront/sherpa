DROP INDEX "traefik_configs_uq";--> statement-breakpoint
ALTER TABLE "portainer_servers" ADD COLUMN "registries" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "server_endpoints" ADD COLUMN "missing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "server_endpoints" ADD COLUMN "inventory" jsonb DEFAULT '{"containers":0,"running":0,"images":0,"stacks":0,"traefik":null}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "traefik_configs" ADD CONSTRAINT "traefik_configs_uq" UNIQUE NULLS NOT DISTINCT("endpoint_id","environment_id");