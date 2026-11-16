-- Seuls les agents Portainer sont désormais pris en charge : un serveur Portainer restant serait
-- pris à tort pour un agent. Le supprimer ou le remplacer par un agent avant de migrer.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "portainer_servers" WHERE "kind" = 'portainer') THEN
    RAISE EXCEPTION 'Serveurs Portainer encore enregistrés : les supprimer ou les remplacer par des agents avant cette migration';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "portainer_servers" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "portainer_servers" DROP COLUMN "registries";--> statement-breakpoint
DROP TYPE "public"."server_kind";