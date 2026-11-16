CREATE TABLE "container_metrics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"container" text NOT NULL,
	"cpu_percent" real,
	"memory_bytes" bigint,
	"memory_limit_bytes" bigint,
	"restart_count" integer
);
--> statement-breakpoint
CREATE TABLE "metric_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"container" text NOT NULL,
	"rule_id" text NOT NULL,
	"rule_name" text NOT NULL,
	"metric" text NOT NULL,
	"threshold" real NOT NULL,
	"value" real,
	"project_id" uuid,
	"environment_id" uuid,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "container_metrics" ADD CONSTRAINT "container_metrics_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_alerts" ADD CONSTRAINT "metric_alerts_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_alerts" ADD CONSTRAINT "metric_alerts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_alerts" ADD CONSTRAINT "metric_alerts_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "container_metrics_lookup_idx" ON "container_metrics" USING btree ("endpoint_id","container","ts");--> statement-breakpoint
CREATE INDEX "container_metrics_ts_idx" ON "container_metrics" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_alerts_active_idx" ON "metric_alerts" USING btree ("endpoint_id","container","rule_id") WHERE resolved_at is null;