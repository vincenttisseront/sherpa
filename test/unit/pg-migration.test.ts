/** Migration PostgreSQL : versions, disposition des données, scripts, PGDATA appliqué à l'analyse. */
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { type AnalyzeContext, analyzeCompose } from '../../server/lib/compose/analyze'
import { PG_IMAGE, dumpScript, oldClusterRemovalScript, pgLayout, pgMajorOf, restoreScript } from '../../server/lib/pg-migration'
import { majorCandidates } from '../../server/services/pg-migration'

const ctx = (over: Partial<AnalyzeContext> = {}): AnalyzeContext => ({
  projectSlug: 'edutis', projectId: 'p1', environmentKey: 'production', environmentId: 'e1', releaseSlug: 'r-0001-abcdef',
  composeDir: '', files: new Set(['compose.yml']), variables: {}, portRules: [], portApprovals: [], volumeRules: [],
  runtimeDir: '/srv/apps-data/production/edutis', workingRoots: ['/srv/deployments/production'], networks: [], dockerVolumes: [],
  ...over,
})

describe('migration PostgreSQL', () => {
  it('images PostgreSQL et version majeure lue dans le tag', () => {
    expect(PG_IMAGE.test('postgres:16-alpine')).toBe(true)
    expect(PG_IMAGE.test('docker.io/postgis/postgis:16-3.4')).toBe(true)
    expect(PG_IMAGE.test('mariadb:11')).toBe(false)
    expect(pgMajorOf('postgres:16-alpine')).toBe(16)
    expect(pgMajorOf('postgres:16.4-bookworm')).toBe(16)
    expect(pgMajorOf('postgres:9.6')).toBe(9)
    expect(pgMajorOf('postgres:latest')).toBeNull()
  })

  it('versions proposées : majeures plus récentes de même forme, la plus récente de chacune, sans préversion', () => {
    const tags = ['16-alpine', '17-alpine', '17.2-alpine', '18-alpine', '18', '19beta1-alpine', '18-bookworm', '15-alpine']
    expect(majorCandidates('16-alpine', tags)).toEqual([{ major: 17, tag: '17-alpine' }, { major: 18, tag: '18-alpine' }])
    expect(majorCandidates('16.4-alpine', ['16.5-alpine', '17.2-alpine', '18.0-alpine'])).toEqual([{ major: 17, tag: '17.2-alpine' }, { major: 18, tag: '18.0-alpine' }])
  })

  it('disposition : nouvelles données dans pgNN du montage, chemins et utilisateur contrôlés', () => {
    expect(pgLayout('/var/lib/postgresql/data', '/var/lib/postgresql/data', 'app', 18).newPgdata).toBe('/var/lib/postgresql/data/pg18')
    expect(pgLayout('/var/lib/postgresql', '/var/lib/postgresql/data', 'app', 18).newPgdata).toBe('/var/lib/postgresql/pg18')
    expect(() => pgLayout('/var/lib/postgresql/data', '/var/lib/postgresql/data', 'app;rm', 18)).toThrow(/Utilisateur/)
    expect(() => pgLayout('/var/lib/post gresql', '/x', 'app', 18)).toThrow(/Chemin/)
    expect(() => pgLayout('/data', '/data/pg18', 'app', 18)).toThrow(/déjà/)
  })

  it('scripts : serveur local sans réseau, sauvegarde atomique, ancienne tentative mise de côté, contrôle des bases', () => {
    const l = pgLayout('/var/lib/postgresql/data', '/var/lib/postgresql/data', 'app', 18)
    const dump = dumpScript(l)
    expect(dump).toContain(`PGDATA='/var/lib/postgresql/data'`)
    expect(dump).toContain(`listen_addresses=''`)
    expect(dump).toMatch(/pg_dumpall -h \/tmp -U 'app' > \/backup\/dump\.sql\.part\nmv /)
    const restore = restoreScript(l)
    expect(restore).toContain(`PGDATA='/var/lib/postgresql/data/pg18'`)
    expect(restore).toContain('.echec-')
    expect(restore).toContain('host all all all scram-sha-256')
    expect(restore).toMatch(/diff -q \/backup\/databases\.before \/backup\/databases\.after/)
    // Locales testées sur le nouveau cluster, repli sur la locale par défaut ; diagnostic des bases absentes.
    expect(restore).toContain('platform_locale_probe')
    // Fichier ouvert par le shell root (le compte postgres n'a pas toujours accès au dossier de sauvegarde, ex. 0750).
    expect(restore).toContain('< /backup/restore.sql')
    expect(restore).not.toMatch(/\$RUN [^\n]*-f \/backup/)
    expect(restore).toContain('Base absente')
    expect(restore).toMatch(/grep -E "ERROR:\|FATAL:\|error:"/)
  })

  it('suppression de l\'ancien cluster : contrôles préalables, sous-dossiers pgNN préservés, chemins contrôlés', () => {
    const nested = oldClusterRemovalScript('/var/lib/postgresql/data', '/var/lib/postgresql/data/pg18')
    expect(nested).toContain('test -s "$NEW/PG_VERSION"')
    expect(nested).toContain('pg[0-9]*) continue')
    expect(nested).not.toContain('rm -rf "$OLD"\n')
    expect(oldClusterRemovalScript('/var/lib/postgresql/data', '/var/lib/postgresql/pg18')).toContain('rm -rf "$OLD"')
    expect(() => oldClusterRemovalScript('/data', '/data/pg18')).toThrow(/Chemin/)
    expect(() => oldClusterRemovalScript("/var/lib/x'y", '/var/lib/pg18')).toThrow(/Chemin/)
  })

  it('analyse : PGDATA du nouveau cluster ajouté au service migré', () => {
    const r = analyzeCompose('services:\n  db:\n    image: postgres:16-alpine\n    environment:\n      - POSTGRES_USER=app\n', ctx({
      imageOverrides: { db: { image: 'postgres:18-alpine', from: 'postgres:16-alpine', at: '', by: null } },
      pgData: { db: { path: '/var/lib/postgresql/data/pg18', major: 18 } },
    }))
    const db = (YAML.parse(r.finalYaml!) as { services: Record<string, { image: string, environment: Record<string, string> }> }).services.db!
    expect(db.image).toBe('postgres:18-alpine')
    expect(db.environment).toMatchObject({ POSTGRES_USER: 'app', PGDATA: '/var/lib/postgresql/data/pg18' })
    expect(r.issues.some(i => i.code === 'pg.migrated')).toBe(true)
  })
})

describe('bibliothèques préchargées', () => {
  it('reprises de la commande du service (Immich : VectorChord), seules options transmises, valeurs contrôlées', async () => {
    const { dumpScript, pgLayout, preloadOptions, restoreScript } = await import('../../server/lib/pg-migration')
    expect(preloadOptions(['postgres', '-c', 'shared_preload_libraries=vchord.so, vectors.so', '-c', 'search_path="$user", public', '-c', 'max_wal_size=2GB'])).toBe('-c shared_preload_libraries=vchord.so,vectors.so')
    expect(preloadOptions(['postgres -c shared_preload_libraries=vectors.so'])).toBe('-c shared_preload_libraries=vectors.so')
    expect(preloadOptions(['postgres', '--shared-preload-libraries=timescaledb'])).toBe('-c shared_preload_libraries=timescaledb')
    expect(preloadOptions(['postgres', '-c', 'shared_preload_libraries=x;rm -rf /'])).toBe('')
    expect(preloadOptions(['postgres'])).toBe('')
    const l = pgLayout('/var/lib/postgresql/data', '/var/lib/postgresql/data', 'postgres', 17)
    expect(dumpScript(l, '-c shared_preload_libraries=vchord.so')).toContain(`PRELOAD='-c shared_preload_libraries=vchord.so'`)
    expect(dumpScript(l)).toContain(`-o "-c listen_addresses='' -c unix_socket_directories=/tmp $PRELOAD"`)
    // Image d'Immich : bibliothèques lues dans le fichier de configuration de la commande, puis dans ses modèles.
    const { configFileOf } = await import('../../server/lib/pg-migration')
    expect(configFileOf(['postgres', '-c', 'config_file=/etc/postgresql/postgresql.conf'])).toBe('/etc/postgresql/postgresql.conf')
    expect(configFileOf(['postgres'])).toBeNull()
    expect(restoreScript(l, '', '/etc/postgresql/postgresql.conf')).toContain('/var/postgresql-conf-tpl/*.conf')
  })
})
