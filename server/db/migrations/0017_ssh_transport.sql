CREATE TYPE "public"."host_transport" AS ENUM('agent', 'ssh');--> statement-breakpoint
CREATE TYPE "public"."ssh_auth_method" AS ENUM('password', 'key');--> statement-breakpoint
ALTER TABLE "portainer_servers" ADD COLUMN "transport" "host_transport" DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "portainer_servers" ADD COLUMN "ssh_host" text;--> statement-breakpoint
ALTER TABLE "portainer_servers" ADD COLUMN "ssh_port" integer;--> statement-breakpoint
ALTER TABLE "portainer_servers" ADD COLUMN "ssh_user" text;--> statement-breakpoint
ALTER TABLE "portainer_servers" ADD COLUMN "ssh_auth" "ssh_auth_method";--> statement-breakpoint
ALTER TABLE "portainer_servers" ADD COLUMN "ssh_host_key" text;--> statement-breakpoint
ALTER TABLE "portainer_servers" ADD COLUMN "ssh_host_key_type" text;--> statement-breakpoint
ALTER TABLE "portainer_servers" ADD COLUMN "docker_socket" text DEFAULT '/var/run/docker.sock' NOT NULL;