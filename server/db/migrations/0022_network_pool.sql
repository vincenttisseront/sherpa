CREATE TABLE "network_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"network" text NOT NULL,
	"subnet" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_endpoints" ADD COLUMN "network_pool" jsonb;--> statement-breakpoint
ALTER TABLE "network_allocations" ADD CONSTRAINT "network_allocations_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_allocations" ADD CONSTRAINT "network_allocations_target_id_project_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."project_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "network_allocations_target_uq" ON "network_allocations" USING btree ("target_id","network");--> statement-breakpoint
CREATE UNIQUE INDEX "network_allocations_subnet_uq" ON "network_allocations" USING btree ("endpoint_id","subnet");