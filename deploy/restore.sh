#!/bin/sh
# Restauration d'une sauvegarde dans la base de la plateforme (REMPLACE les données).
#   deploy/restore.sh backups/platform-AAAAMMJJTHHMMSSZ.dump
# Procédure : arrêter app et worker, restaurer, relancer (les migrations rejouent au démarrage).
# Exige la même clé maîtresse (MASTER_KEY_FILE) que lors de la sauvegarde.
set -eu
FILE="${1:?Fichier de sauvegarde requis}"
COMPOSE="${COMPOSE:-docker compose}"
[ -s "$FILE" ] || { echo "Fichier introuvable ou vide : $FILE" >&2; exit 1; }
$COMPOSE stop app worker
$COMPOSE exec -T postgres pg_restore -U platform -d platform --clean --if-exists --no-owner --single-transaction < "$FILE"
$COMPOSE up -d --wait app worker
echo "Restauration terminée depuis $FILE"
