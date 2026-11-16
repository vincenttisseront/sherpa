CREATE TYPE "public"."access_mode" AS ENUM('ro', 'rw');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'failure', 'denied');--> statement-breakpoint
CREATE TYPE "public"."deployment_action" AS ENUM('deploy', 'redeploy', 'stop', 'start', 'restart', 'delete', 'rollback');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('DRAFT', 'VALIDATING', 'VALIDATION_FAILED', 'QUEUED', 'PREPARING_FILES', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECKING', 'HEALTHY', 'DEGRADED', 'FAILED', 'ROLLING_BACK', 'ROLLED_BACK', 'STOPPED', 'DELETING', 'DELETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."endpoint_type" AS ENUM('docker_standalone', 'docker_swarm', 'kubernetes', 'other');--> statement-breakpoint
CREATE TYPE "public"."exposure" AS ENUM('internal', 'external');--> statement-breakpoint
CREATE TYPE "public"."git_ref_type" AS ENUM('branch', 'tag', 'commit');--> statement-breakpoint
CREATE TYPE "public"."idp_kind" AS ENUM('keycloak', 'okta', 'oidc');--> statement-breakpoint
CREATE TYPE "public"."log_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."log_phase" AS ENUM('validation', 'extraction', 'build', 'portainer', 'service', 'healthcheck', 'system');--> statement-breakpoint
CREATE TYPE "public"."network_role" AS ENUM('none', 'traefik', 'app');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('email', 'teams_webhook', 'teams_graph');--> statement-breakpoint
CREATE TYPE "public"."policy_status" AS ENUM('unreviewed', 'allowed', 'forbidden');--> statement-breakpoint
CREATE TYPE "public"."port_policy" AS ENUM('allowed', 'approval', 'forbidden');--> statement-breakpoint
CREATE TYPE "public"."port_protocol" AS ENUM('tcp', 'udp');--> statement-breakpoint
CREATE TYPE "public"."runner_status" AS ENUM('unconfigured', 'online', 'offline', 'error');--> statement-breakpoint
CREATE TYPE "public"."server_status" AS ENUM('unknown', 'online', 'degraded', 'offline');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('github', 'zip');--> statement-breakpoint
CREATE TYPE "public"."subject_type" AS ENUM('user', 'group');--> statement-breakpoint
CREATE TYPE "public"."user_kind" AS ENUM('local', 'sso', 'external');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'suspended', 'locked', 'expired');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"server_id" uuid,
	"environment_id" uuid,
	"project_id" uuid,
	"outcome" "audit_outcome" NOT NULL,
	"ip" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"ts" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"phase" "log_phase" NOT NULL,
	"level" "log_level" DEFAULT 'info' NOT NULL,
	"service" text,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"release_id" uuid,
	"action" "deployment_action" NOT NULL,
	"status" "deployment_status" DEFAULT 'DRAFT' NOT NULL,
	"idempotency_key" text NOT NULL,
	"job_id" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"requested_by" uuid,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "docker_volumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"name" text NOT NULL,
	"driver" text,
	"mountpoint" text,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"missing" boolean DEFAULT false NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoint_environments" (
	"endpoint_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	CONSTRAINT "endpoint_environments_endpoint_id_environment_id_pk" PRIMARY KEY("endpoint_id","environment_id")
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_production" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "identity_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"kind" "idp_kind" NOT NULL,
	"name" text NOT NULL,
	"issuer_url" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_id" uuid,
	"scopes" text[] DEFAULT ARRAY['openid','profile','email']::text[] NOT NULL,
	"groups_claim" text DEFAULT 'groups' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_providers_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "idp_group_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idp_id" uuid NOT NULL,
	"external_group" text NOT NULL,
	"group_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "networks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"docker_id" text NOT NULL,
	"name" text NOT NULL,
	"driver" text,
	"scope" text,
	"internal" boolean DEFAULT false NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy" "policy_status" DEFAULT 'unreviewed' NOT NULL,
	"role" "network_role" DEFAULT 'none' NOT NULL,
	"external" boolean DEFAULT true NOT NULL,
	"description" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"allowed_environment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"missing" boolean DEFAULT false NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"name" text NOT NULL,
	"config_secret_id" uuid NOT NULL,
	"events" text[] NOT NULL,
	"environment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "path_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"working_root" text NOT NULL,
	"build_root" text NOT NULL,
	"tmp_root" text NOT NULL,
	"runtime_root" text NOT NULL,
	"auto_create" boolean DEFAULT true NOT NULL,
	"dir_mode" text DEFAULT '0750' NOT NULL,
	"owner_uid" integer,
	"group_gid" integer,
	"min_free_disk_mb" integer DEFAULT 20480 NOT NULL,
	"max_project_size_mb" integer DEFAULT 1024 NOT NULL,
	"releases_to_keep" integer DEFAULT 5 NOT NULL,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"forbidden_paths" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "port_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid,
	"environment_id" uuid,
	"port_from" integer NOT NULL,
	"port_to" integer NOT NULL,
	"protocol" "port_protocol" DEFAULT 'tcp' NOT NULL,
	"policy" "port_policy" NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "port_rules_range" CHECK ("port_rules"."port_from" BETWEEN 1 AND 65535 AND "port_rules"."port_to" BETWEEN "port_rules"."port_from" AND 65535)
);
--> statement-breakpoint
CREATE TABLE "portainer_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"token_secret_id" uuid NOT NULL,
	"tls_verify" boolean DEFAULT true NOT NULL,
	"ca_cert_pem" text,
	"detected_version" text,
	"status" "server_status" DEFAULT 'unknown' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_discovery_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portainer_servers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "project_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "source_kind" NOT NULL,
	"repository" text,
	"ref_type" "git_ref_type",
	"ref" text,
	"subdirectory" text,
	"compose_path" text DEFAULT 'compose.yml' NOT NULL,
	"dockerfile_path" text,
	"build_args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submodules" boolean DEFAULT false NOT NULL,
	"token_secret_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_sources_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "project_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"compose_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"env_secret_id" uuid,
	"watchtower" jsonb DEFAULT '{"enabled":false,"services":{}}'::jsonb NOT NULL,
	"portainer_stack_id" integer,
	"current_release_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_user_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"source_kind" "source_kind" NOT NULL,
	"commit_sha" text,
	"archive_sha256" text,
	"compose_source" text,
	"compose_final" text,
	"images" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"remote_path" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "role_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" uuid NOT NULL,
	"subject_type" "subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"server_id" uuid,
	"environment_id" uuid,
	"project_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"builtin" boolean DEFAULT false NOT NULL,
	"permissions" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"table_key" text NOT NULL,
	"name" text NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"envelope" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "server_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"portainer_endpoint_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" "endpoint_type" NOT NULL,
	"url" text,
	"online" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"idp_id" uuid,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "target_runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"url" text NOT NULL,
	"auth_secret_id" uuid,
	"status" "runner_status" DEFAULT 'unconfigured' NOT NULL,
	"version" text,
	"allowed_actions" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_concurrent_builds" integer DEFAULT 2 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_runners_endpoint_id_unique" UNIQUE("endpoint_id")
);
--> statement-breakpoint
CREATE TABLE "traefik_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"environment_id" uuid,
	"network_name" text NOT NULL,
	"cert_resolver" text,
	"entrypoint_http" text DEFAULT 'web' NOT NULL,
	"entrypoint_https" text DEFAULT 'websecure' NOT NULL,
	"allowed_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"default_middlewares" text[] DEFAULT '{}'::text[] NOT NULL,
	"router_name_pattern" text DEFAULT '{project}-{env}-{service}' NOT NULL,
	"exposure" "exposure" DEFAULT 'internal' NOT NULL,
	"redirect_to_https" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"from_idp" boolean DEFAULT false NOT NULL,
	CONSTRAINT "user_groups_user_id_group_id_pk" PRIMARY KEY("user_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" "user_kind" NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"password_hash" text,
	"idp_id" uuid,
	"idp_subject" text,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_local_password" CHECK ("users"."kind" <> 'sso' OR "users"."password_hash" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "volume_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"host_path" text NOT NULL,
	"mode" "access_mode" DEFAULT 'ro' NOT NULL,
	"project_id" uuid,
	"environment_id" uuid,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_target_id_project_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."project_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_volumes" ADD CONSTRAINT "docker_volumes_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_environments" ADD CONSTRAINT "endpoint_environments_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_environments" ADD CONSTRAINT "endpoint_environments_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_client_secret_id_secrets_id_fk" FOREIGN KEY ("client_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_group_mappings" ADD CONSTRAINT "idp_group_mappings_idp_id_identity_providers_id_fk" FOREIGN KEY ("idp_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_group_mappings" ADD CONSTRAINT "idp_group_mappings_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "networks" ADD CONSTRAINT "networks_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_config_secret_id_secrets_id_fk" FOREIGN KEY ("config_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_configs" ADD CONSTRAINT "path_configs_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_configs" ADD CONSTRAINT "path_configs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "path_configs" ADD CONSTRAINT "path_configs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "port_rules" ADD CONSTRAINT "port_rules_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "port_rules" ADD CONSTRAINT "port_rules_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portainer_servers" ADD CONSTRAINT "portainer_servers_token_secret_id_secrets_id_fk" FOREIGN KEY ("token_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_token_secret_id_secrets_id_fk" FOREIGN KEY ("token_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_targets" ADD CONSTRAINT "project_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_targets" ADD CONSTRAINT "project_targets_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_targets" ADD CONSTRAINT "project_targets_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_targets" ADD CONSTRAINT "project_targets_env_secret_id_secrets_id_fk" FOREIGN KEY ("env_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_target_id_project_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."project_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_server_id_portainer_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."portainer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_endpoints" ADD CONSTRAINT "server_endpoints_server_id_portainer_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."portainer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_idp_id_identity_providers_id_fk" FOREIGN KEY ("idp_id") REFERENCES "public"."identity_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_runners" ADD CONSTRAINT "target_runners_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_runners" ADD CONSTRAINT "target_runners_auth_secret_id_secrets_id_fk" FOREIGN KEY ("auth_secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traefik_configs" ADD CONSTRAINT "traefik_configs_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traefik_configs" ADD CONSTRAINT "traefik_configs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_idp_id_identity_providers_id_fk" FOREIGN KEY ("idp_id") REFERENCES "public"."identity_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_rules" ADD CONSTRAINT "volume_rules_endpoint_id_server_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."server_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_rules" ADD CONSTRAINT "volume_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_rules" ADD CONSTRAINT "volume_rules_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_rules" ADD CONSTRAINT "volume_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_ts_idx" ON "audit_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id","ts");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "deployment_logs_deployment_idx" ON "deployment_logs" USING btree ("deployment_id","id");--> statement-breakpoint
CREATE INDEX "deployment_logs_ts_idx" ON "deployment_logs" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "deployments_target_idx" ON "deployments" USING btree ("target_id","created_at");--> statement-breakpoint
CREATE INDEX "deployments_status_idx" ON "deployments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "docker_volumes_uq" ON "docker_volumes" USING btree ("endpoint_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "idp_group_mappings_uq" ON "idp_group_mappings" USING btree ("idp_id","external_group","group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "networks_uq" ON "networks" USING btree ("endpoint_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "path_configs_uq" ON "path_configs" USING btree ("endpoint_id","environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_targets_uq" ON "project_targets" USING btree ("project_id","endpoint_id","environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "releases_number_uq" ON "releases" USING btree ("target_id","number");--> statement-breakpoint
CREATE INDEX "role_bindings_subject_idx" ON "role_bindings" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_uq" ON "saved_views" USING btree ("user_id","table_key","name");--> statement-breakpoint
CREATE UNIQUE INDEX "server_endpoints_uq" ON "server_endpoints" USING btree ("server_id","portainer_endpoint_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "traefik_configs_uq" ON "traefik_configs" USING btree ("endpoint_id","environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_idp_subject_uq" ON "users" USING btree ("idp_id","idp_subject");