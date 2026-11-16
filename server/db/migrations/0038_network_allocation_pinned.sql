ALTER TABLE "network_allocations" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Sous-réseaux déjà fixés par le plan d'adressage (déplacement avec redéploiement, unitaire ou groupé) : marqués fixés.
UPDATE "network_allocations" a SET "pinned" = true
WHERE EXISTS (
  SELECT 1 FROM "audit_events" e
  WHERE e."target_type" = 'server_endpoint' AND e."target_id" = a."endpoint_id"::text
    AND (
      (e."action" = 'network.move' AND e."details"->>'mode' = 'redeploy' AND e."details"->>'to' = a."subnet")
      OR (e."action" = 'network.move_all' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e."details"->'moves') = 'array' THEN e."details"->'moves' ELSE '[]'::jsonb END) m
        WHERE m->>'mode' = 'redeploy' AND m->>'to' = a."subnet" AND m->>'error' IS NULL
      ))
    )
);
