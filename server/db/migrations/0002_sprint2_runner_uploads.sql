CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_path" text NOT NULL,
	"original_name" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "upload_id" uuid;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "source_tree_sha256" text;--> statement-breakpoint
ALTER TABLE "target_runners" ADD COLUMN "ca_cert_pem" text;--> statement-breakpoint
ALTER TABLE "target_runners" ADD COLUMN "server_name" text;--> statement-breakpoint
ALTER TABLE "target_runners" ADD COLUMN "host_roots" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "target_runners" ADD COLUMN "hostname" text;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE set null ON UPDATE no action;