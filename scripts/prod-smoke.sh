#!/bin/sh
# Essai de la configuration de production en local (projet Compose isolé « pp-prod-smoke »).
#   scripts/prod-smoke.sh up | down | logs | e2e
# e2e : premier démarrage dans le navigateur (instance vierge, juste après « up »).
# Secrets générés dans .data/prod-smoke/secrets (jamais affichés).
set -eu
cd "$(dirname "$0")/.."
DIR=.data/prod-smoke
export APP_DOMAIN=localhost:3200 APP_VERSION=smoke
# Instance locale d'essai : webhooks de la boîte de développement acceptés.
export NOTIFY_WEBHOOK_ALLOWED_HOSTS="${NOTIFY_WEBHOOK_ALLOWED_HOSTS:-*.webhook.office.com,*.logic.azure.com,*.api.powerplatform.com}"
dc() { docker compose -f docker-compose.yml -f deploy/compose.smoke.yml --project-directory "$DIR" -p pp-prod-smoke "$@"; }
case "${1:-up}" in
  up)
    mkdir -p "$DIR/secrets"
    for f in master_key db_password redis_password; do
      [ -s "$DIR/secrets/$f" ] || { umask 077; case $f in master_key) openssl rand -base64 32 ;; *) openssl rand -hex 24 ;; esac > "$DIR/secrets/$f"; }
    done
    for f in master_keys_previous smtp_password; do [ -e "$DIR/secrets/$f" ] || : > "$DIR/secrets/$f"; done
    [ -s "$DIR/secrets/runner-client.crt" ] || cp .data/runner-dev/pki/platform-client.crt "$DIR/secrets/runner-client.crt"
    [ -s "$DIR/secrets/runner-client.key" ] || cp .data/runner-dev/pki/platform-client.key "$DIR/secrets/runner-client.key"
    # Lisibles par l'utilisateur des conteneurs (secrets Compose montés depuis des fichiers).
    chmod 0444 "$DIR"/secrets/*
    docker tag sherpa:dev sherpa:smoke
    dc up -d --wait
    ;;
  e2e)
    # Jeton d'initialisation extrait des logs vers un fichier privé (jamais affiché).
    umask 077
    dc logs app 2>/dev/null | sed -n "s/.*Jeton d'initialisation (usage unique, valable 24 h) : \([A-Za-z0-9_-]*\).*/\1/p" | tail -1 > "$DIR/setup-token"
    [ -s "$DIR/setup-token" ] || { echo "Jeton d'initialisation introuvable (instance déjà initialisée ?)" >&2; exit 1; }
    E2E_FRESH=1 E2E_BASE_URL=http://localhost:3200 E2E_SETUP_TOKEN_FILE="$DIR/setup-token" E2E_ADMIN_PASSWORD_OUT="$DIR/admin-password" npm exec --no-install -- playwright test e2e/onboarding.spec.ts
    rm -f "$DIR/setup-token"
    ;;
  down) dc down -v ;;
  logs) dc logs --tail 100 ;;
esac
