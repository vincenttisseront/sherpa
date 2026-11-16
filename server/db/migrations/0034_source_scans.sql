CREATE TABLE "source_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"release_id" uuid,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"counts" jsonb NOT NULL,
	"fixable" integer DEFAULT 0 NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifests" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "source_scans_target_id_unique" UNIQUE("target_id")
);
--> statement-breakpoint
ALTER TABLE "source_scans" ADD CONSTRAINT "source_scans_target_id_project_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."project_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_scans" ADD CONSTRAINT "source_scans_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;