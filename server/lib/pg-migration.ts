/**
 * Migration de PostgreSQL vers une nouvelle version majeure, par sauvegarde puis restauration,
 * entièrement sur l'hôte (les données ne transitent jamais par la console) :
 *
 * 1. conteneur éphémère sur l'image actuelle : serveur local (socket seule) sur les données
 *    existantes, `pg_dumpall` dans un répertoire de sauvegarde de l'hôte ;
 * 2. conteneur éphémère sur la nouvelle image : cluster neuf dans un sous-dossier du même volume
 *    (`<montage>/pgNN`), restauration de la sauvegarde ;
 * 3. le service redémarre sur la nouvelle image avec PGDATA pointant sur ce sous-dossier.
 *
 * Les anciennes données ne sont jamais modifiées : revenir à l'image précédente (sans PGDATA)
 * les retrouve telles quelles.
 */

/** Familles d'images servies par le même moteur (outils pg_dumpall / initdb / pg_ctl). */
export const PG_IMAGE = /(^|\/)(postgres|postgis|timescaledb(-ha)?)(:|@|$)/i

const SAFE_PATH = /^\/[A-Za-z0-9._/-]{1,255}$/
const SAFE_USER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

/** Version majeure lue dans le tag (16-alpine → 16, 16.4-bookworm → 16, 3.5-postgis… → null). */
export function pgMajorOf(image: string): number | null {
  const tag = image.split('@')[0]!.split(':').at(-1) ?? ''
  const m = /^(\d{1,2})(?:[.-]|$)/.exec(tag)
  const n = m ? Number(m[1]) : Number.NaN
  return n >= 9 && n <= 99 ? n : null
}

export interface PgMigrationLayout {
  /** Destination du montage des données dans le conteneur (ex. /var/lib/postgresql/data). */
  mountPath: string
  /** PGDATA actuel (le montage lui-même, ou un sous-dossier). */
  oldPgdata: string
  /** PGDATA de la nouvelle version : sous-dossier pgNN du montage. */
  newPgdata: string
  /** Superutilisateur (POSTGRES_USER du service). */
  user: string
}

export function pgLayout(mountPath: string, oldPgdata: string, user: string, targetMajor: number): PgMigrationLayout {
  for (const p of [mountPath, oldPgdata]) if (!SAFE_PATH.test(p) || p.split('/').includes('..')) throw new Error(`Chemin invalide : ${p}`)
  if (!SAFE_USER.test(user)) throw new Error(`Utilisateur PostgreSQL invalide : ${user}`)
  const newPgdata = `${mountPath.replace(/\/+$/, '')}/pg${targetMajor}`
  if (newPgdata === oldPgdata) throw new Error(`Les données sont déjà dans ${newPgdata}`)
  return { mountPath, oldPgdata, newPgdata, user }
}

/** Exécution sous le compte postgres de l'image (su-exec sur Alpine, gosu sur Debian). */
const AS_POSTGRES = 'if command -v su-exec >/dev/null 2>&1; then RUN="su-exec postgres"; else RUN="gosu postgres"; fi'
/** Serveur sans réseau, sur une socket privée : personne d'autre ne peut écrire pendant l'opération. */
const LOCAL_ONLY = `-c listen_addresses='' -c unix_socket_directories=/tmp`

const PRELOAD_KEYS = ['shared_preload_libraries', 'session_preload_libraries']

/**
 * Bibliothèques préchargées par la commande du service (ex. image d'Immich : VectorChord,
 * pgvecto.rs), à redonner au serveur temporaire : sans elles, pg_dump et la restauration échouent
 * sur les objets de ces extensions (« vchord must be loaded via shared_preload_libraries »).
 * Seules ces options passent, valeurs contrôlées (noms de bibliothèques séparés par des virgules).
 */
export function preloadOptions(cmd: readonly string[]): string {
  const out: string[] = []
  for (let i = 0; i < cmd.length; i++) {
    const tok = cmd[i]!
    // Commande sous forme de chaîne unique (« postgres -c a=b ») : découpée.
    if (/\s/.test(tok) && i === 0 && cmd.length === 1) return preloadOptions(tok.split(/\s+/))
    const kv = tok === '-c' ? cmd[++i] ?? '' : tok.startsWith('-c') ? tok.slice(2) : tok.startsWith('--') ? tok.slice(2) : ''
    const eq = kv.indexOf('=')
    if (eq < 0) continue
    const key = kv.slice(0, eq).trim().replace(/-/g, '_')
    const value = kv.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '').replace(/\s+/g, '')
    if (PRELOAD_KEYS.includes(key) && /^[A-Za-z0-9_.,-]{1,200}$/.test(value)) out.push(`-c ${key}=${value}`)
  }
  return out.join(' ')
}

/** Fichier de configuration imposé par la commande (« -c config_file=… ») : lu par le serveur temporaire. */
export function configFileOf(cmd: readonly string[]): string | null {
  const flat = cmd.length === 1 && /\s/.test(cmd[0]!) ? cmd[0]!.split(/\s+/) : cmd
  for (let i = 0; i < flat.length; i++) {
    const kv = flat[i] === '-c' ? flat[i + 1] ?? '' : flat[i]!.startsWith('-c') ? flat[i]!.slice(2) : flat[i]!.startsWith('--') ? flat[i]!.slice(2) : ''
    const m = /^config[_-]file=(\/[A-Za-z0-9._/-]{1,200})$/.exec(kv)
    if (m) return m[1]!
  }
  return null
}

/**
 * Bibliothèques préchargées lues dans l'image elle-même, quand la commande ne les donne pas :
 * fichier de configuration de la commande, puis modèles de configuration courants (l'image d'Immich
 * génère /etc/postgresql/postgresql.conf au démarrage depuis /var/postgresql-conf-tpl). Valeur
 * contrôlée (noms de bibliothèques) avant d'être passée au serveur temporaire.
 */
function preloadDiscovery(preload: string, configFile: string | null): string[] {
  if (preload) return [`PRELOAD='${preload}'`]
  const files = [configFile, '/etc/postgresql/postgresql.conf', '/var/postgresql-conf-tpl/postgresql.ssd.conf', '/var/postgresql-conf-tpl/*.conf', '/etc/postgresql/*.conf'].filter((f): f is string => !!f)
  return [
    `LIBS=$(grep -h -E "^[[:space:]]*shared_preload_libraries[[:space:]]*=" ${files.join(' ')} 2>/dev/null | head -n 1 | sed -E "s/^[^=]*=[[:space:]]*//; s/#.*$//; s/['\\" ]//g" || true)`,
    'PRELOAD=""',
    'if [ -n "$LIBS" ] && echo "$LIBS" | grep -qE "^[A-Za-z0-9_.,-]{1,200}$"; then PRELOAD="-c shared_preload_libraries=$LIBS"; fi',
  ]
}

/** Étape 1, image actuelle : sauvegarde complète (rôles, bases, droits) dans /backup/dump.sql. */
export function dumpScript(l: PgMigrationLayout, preload = '', configFile: string | null = null): string {
  return [
    'set -eu',
    AS_POSTGRES,
    `PGDATA='${l.oldPgdata}'`,
    'test -s "$PGDATA/PG_VERSION" || { echo "Aucune donnée PostgreSQL dans $PGDATA"; exit 3; }',
    'echo "Version des données : $(cat "$PGDATA/PG_VERSION")"',
    // Arrêt brutal précédent : fichier de verrou périmé, le serveur ne tourne plus (stack arrêtée).
    'rm -f "$PGDATA/postmaster.pid"',
    ...preloadDiscovery(preload, configFile),
    'if [ -n "$PRELOAD" ]; then echo "Bibliothèques préchargées : ${PRELOAD#*=}"; fi',
    `$RUN pg_ctl -D "$PGDATA" -o "${LOCAL_ONLY} $PRELOAD" -w -t 600 start`,
    `$RUN pg_dumpall -h /tmp -U '${l.user}' > /backup/dump.sql.part`,
    'mv /backup/dump.sql.part /backup/dump.sql',
    `$RUN psql -h /tmp -U '${l.user}' -d postgres -tAc "select datname from pg_database where not datistemplate order by 1" > /backup/databases.before`,
    '$RUN pg_ctl -D "$PGDATA" -m fast -w stop',
    'echo "Sauvegarde : $(wc -c < /backup/dump.sql) octets, bases : $(tr \'\\n\' \' \' < /backup/databases.before)"',
  ].join('\n')
}

/** Étape 2, nouvelle image : cluster neuf dans newPgdata, restauration, contrôle des bases. */
export function restoreScript(l: PgMigrationLayout, preload = '', configFile: string | null = null): string {
  return [
    'set -eu',
    AS_POSTGRES,
    `PGDATA='${l.newPgdata}'`,
    // Tentative précédente interrompue : mise de côté, jamais supprimée.
    'if [ -e "$PGDATA" ] && [ -n "$(ls -A "$PGDATA" 2>/dev/null)" ]; then mv "$PGDATA" "$PGDATA.echec-$(date +%Y%m%d%H%M%S)"; fi',
    'mkdir -p "$PGDATA" && chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA"',
    `$RUN initdb -D "$PGDATA" -U '${l.user}' --auth-local=trust --auth-host=scram-sha-256 > /backup/initdb.log`,
    // Mêmes accès réseau que l'image officielle (mot de passe pour toute connexion TCP).
    'echo "host all all all scram-sha-256" >> "$PGDATA/pg_hba.conf"',
    `grep -q "^listen_addresses" "$PGDATA/postgresql.conf" || echo "listen_addresses = '*'" >> "$PGDATA/postgresql.conf"`,
    ...preloadDiscovery(preload, configFile),
    'if [ -n "$PRELOAD" ]; then echo "Bibliothèques préchargées : ${PRELOAD#*=}"; fi',
    `$RUN pg_ctl -D "$PGDATA" -o "${LOCAL_ONLY} $PRELOAD" -w -t 600 start`,
    // Locales des bases : testées sur le nouveau cluster ; une locale absente de la nouvelle image ferait
    // échouer CREATE DATABASE (et perdre la base) : la base prend alors la locale par défaut du cluster.
    'cp /backup/dump.sql /backup/restore.sql',
    `for loc in $(grep -o -E "(LOCALE|LC_COLLATE|LC_CTYPE) = '[^']*'" /backup/restore.sql | sed -E "s/^[A-Z_]+ = '(.*)'$/\\1/" | sort -u); do`,
    `  if $RUN psql -h /tmp -U '${l.user}' -d postgres -X -q -c "CREATE DATABASE platform_locale_probe TEMPLATE template0 LOCALE '$loc'" > /dev/null 2>&1; then`,
    `    $RUN psql -h /tmp -U '${l.user}' -d postgres -X -q -c "DROP DATABASE platform_locale_probe" > /dev/null 2>&1`,
    '  else',
    '    echo "Locale $loc indisponible dans la nouvelle image : bases concernées créées avec la locale par défaut du cluster"',
    `    sed -i -E "/^CREATE DATABASE /s/ (LOCALE_PROVIDER = libc )?(LOCALE|LC_COLLATE|LC_CTYPE) = '$loc'//g" /backup/restore.sql`,
    '  fi',
    'done',
    `$RUN psql -h /tmp -U '${l.user}' -d postgres -X -q < /backup/restore.sql > /backup/restore.log 2>&1 || true`,
    `$RUN psql -h /tmp -U '${l.user}' -d postgres -tAc "select datname from pg_database where not datistemplate order by 1" > /backup/databases.after`,
    '$RUN pg_ctl -D "$PGDATA" -m fast -w stop',
    // Erreurs attendues : rôle du superutilisateur déjà créé par initdb. Erreurs du serveur (ERROR, FATAL)
    // et du client psql (error:, ex. \connect impossible) : toutes signalées.
    `ERRORS=$(grep -E "ERROR:|FATAL:|error:" /backup/restore.log | grep -v "role \\"${l.user}\\" already exists" | grep -v "current user cannot be dropped" | grep -v "cannot drop the currently open database" || true)`,
    'if [ -n "$ERRORS" ]; then echo "Erreurs de restauration :"; echo "$ERRORS" | head -20; exit 4; fi',
    'if ! diff -q /backup/databases.before /backup/databases.after >/dev/null; then',
    '  echo "Bases différentes après restauration :"; echo "avant : $(tr \'\\n\' \' \' < /backup/databases.before)"; echo "après : $(tr \'\\n\' \' \' < /backup/databases.after)"',
    '  for db in $(cat /backup/databases.before); do grep -qx "$db" /backup/databases.after && continue; echo "Base absente : $db ; création dans la sauvegarde :"; grep -E "^CREATE DATABASE \\"?$db\\"? " /backup/restore.sql | head -1 || echo "(aucune : base non sauvegardée)"; done',
    '  echo "Journal de restauration (extraits) :"; grep -v -E "^(SET|set_config|-+|\\(1 row\\)| *)$" /backup/restore.log | head -15',
    '  exit 5',
    'fi',
    'echo "Restauration conforme : $(tr \'\\n\' \' \' < /backup/databases.after)"',
  ].join('\n')
}

/**
 * Suppression de l'ancien cluster, une fois la nouvelle version validée : refusée si l'ancien
 * n'est plus là ou si le nouveau est absent. Ancien cluster parent du nouveau (PGDATA = montage) :
 * seuls ses fichiers sont supprimés, jamais les sous-dossiers pgNN (clusters migrés).
 */
export function oldClusterRemovalScript(oldPgdata: string, newPgdata: string): string {
  for (const p of [oldPgdata, newPgdata]) if (!SAFE_PATH.test(p) || p.split('/').includes('..') || p.split('/').filter(Boolean).length < 2) throw new Error(`Chemin invalide : ${p}`)
  const nested = newPgdata.startsWith(`${oldPgdata.replace(/\/+$/, '')}/`)
  return [
    'set -eu',
    `OLD='${oldPgdata}'`,
    `NEW='${newPgdata}'`,
    'test -s "$OLD/PG_VERSION" || { echo "Ancien cluster absent de $OLD (déjà supprimé ?)"; exit 3; }',
    'test -s "$NEW/PG_VERSION" || { echo "Nouveau cluster absent de $NEW : suppression refusée"; exit 4; }',
    'echo "Ancien cluster : PostgreSQL $(cat "$OLD/PG_VERSION"), $(du -sh "$OLD" | cut -f1) avec les sous-dossiers"',
    nested
      ? 'for e in "$OLD"/* "$OLD"/.[!.]* "$OLD"/..?*; do [ -e "$e" ] || continue; case "$(basename "$e")" in pg[0-9]*) continue ;; esac; rm -rf "$e"; done'
      : 'rm -rf "$OLD"',
    'echo "Ancien cluster supprimé ; nouveau cluster intact : PostgreSQL $(cat "$NEW/PG_VERSION")"',
  ].join('\n')
}
