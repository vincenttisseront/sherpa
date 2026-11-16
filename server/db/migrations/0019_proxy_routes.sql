CREATE TABLE "proxy_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"stack" text,
	"service" text,
	"container_name" text NOT NULL,
	"host" text NOT NULL,
	"path_prefix" text,
	"port" integer NOT NULL,
	"https" boolean DEFAULT true NOT NULL,
	"network" text NOT NULL,
	"attached_by_platform" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_proxies" ADD COLUMN "applied_routes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "proxy_routes" ADD CONSTRAINT "proxy_routes_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_routes" ADD CONSTRAINT "proxy_routes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proxy_routes_host_uq" ON "proxy_routes" USING btree ("endpoint_id","host","path_prefix");