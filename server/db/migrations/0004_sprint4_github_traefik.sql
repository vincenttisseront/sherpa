ALTER TABLE "project_sources" ADD COLUMN "api_url" text DEFAULT 'https://api.github.com' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_targets" ADD COLUMN "exposures" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "repository" text;