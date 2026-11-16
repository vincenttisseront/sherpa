#!/bin/sh
# Sauvegarde de la base PostgreSQL de la plateforme (format personnalisé pg_dump, compressé).
#   deploy/backup.sh [répertoire]          (défaut : ./backups)
#   COMPOSE="docker compose -p <projet>" deploy/backup.sh   (autre projet Compose)
# La clé maîtresse n'est PAS dans la sauvegarde : la conserver à part (coffre), sinon
# les secrets (tokens Portainer, clients OIDC, webhooks) seront illisibles après restauration.
# Rétention locale : BACKUP_KEEP (défaut 14) fichiers les plus récents.
set -eu
DIR="${1:-./backups}"
COMPOSE="${COMPOSE:-docker compose}"
KEEP="${BACKUP_KEEP:-14}"
mkdir -p "$DIR"
umask 077
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$DIR/platform-$STAMP.dump"
$COMPOSE exec -T postgres pg_dump -U platform -d platform -Fc -Z 6 > "$FILE.partial"
# Contrôle d'intégrité : l'archive doit être lisible et contenir le schéma attendu.
$COMPOSE exec -T postgres pg_restore -l < "$FILE.partial" | grep -q "TABLE public deployments" || { echo "Sauvegarde invalide" >&2; rm -f "$FILE.partial"; exit 1; }
mv "$FILE.partial" "$FILE"
echo "Sauvegarde : $FILE ($(wc -c < "$FILE" | tr -d ' ') octets)"
ls -1t "$DIR"/platform-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old"; done
