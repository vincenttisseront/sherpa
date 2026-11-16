CREATE TYPE "public"."server_kind" AS ENUM('portainer', 'agent');--> statement-breakpoint
ALTER TABLE "portainer_servers" ADD COLUMN "kind" "server_kind" DEFAULT 'portainer' NOT NULL;