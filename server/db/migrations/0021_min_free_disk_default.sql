ALTER TABLE "path_configs" ALTER COLUMN "min_free_disk_mb" SET DEFAULT 2048;--> statement-breakpoint
-- Configurations restées sur l'ancien défaut (20 Go, disproportionné pour une reprise ou un petit projet) : nouveau défaut.
UPDATE "path_configs" SET "min_free_disk_mb" = 2048 WHERE "min_free_disk_mb" = 20480;
