CREATE TABLE "remediation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"endpoint_id" uuid,
	"image_ref" text,
	"target_id" uuid,
	"label" text NOT NULL,
	"api_url" text NOT NULL,
	"repository" text NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"vuln_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "image_scans" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "remediation_requests" ADD CONSTRAINT "remediation_requests_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_requests" ADD CONSTRAINT "remediation_requests_target_id_project_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."project_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_requests" ADD CONSTRAINT "remediation_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "remediation_requests_issue_uq" ON "remediation_requests" USING btree ("api_url","repository","number");