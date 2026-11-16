/**
 * Configuration lue depuis l'environnement, validée au démarrage.
 * Utilisable à la fois par Nitro et par le worker (pas d'auto-import Nuxt).
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { trimTrailingSlashes } from '../../shared/utils/trim'

/** Connexion PostgreSQL de développement local (compose.dev.yml) : refusée en production, où DATABASE_URL (+ DATABASE_PASSWORD_FILE) est obligatoire. */
const DEV_DATABASE_URL = 'postgres://platform:platform@localhost:5432/platform' // NOSONAR : identifiants de développement, rejetés en production par env()

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1).default(DEV_DATABASE_URL),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  /** Mots de passe lus dans des fichiers (secrets Docker) et injectés dans les URL ci-dessus. */
  DATABASE_PASSWORD_FILE: z.string().optional(),
  REDIS_PASSWORD_FILE: z.string().optional(),
  MASTER_KEY: z.string().optional(),
  MASTER_KEY_FILE: z.string().optional(),
  MASTER_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('k1'),
  MASTER_KEYS_PREVIOUS: z.string().optional(),
  MASTER_KEYS_PREVIOUS_FILE: z.string().optional(),
  PORTAINER_ADAPTER: z.enum(['mock', 'http']).default('mock'),
  RUNNER_ADAPTER: z.enum(['mock', 'http']).default('mock'),
  PORTAINER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  PORTAINER_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  DEV_AUTH_BYPASS: z.stringbool().default(false),
  /** URL publique de la plateforme (retours OIDC, liens d'invitation). */
  APP_URL: z.url().default('http://localhost:3000').transform(u => trimTrailingSlashes(u)),
  SESSION_IDLE_MIN: z.coerce.number().int().min(5).max(24 * 60).default(60),
  SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(24 * 7).default(12),
  /** Cookie de session « Secure » (HTTPS). À désactiver uniquement en développement HTTP. */
  COOKIE_SECURE: z.stringbool().default(true),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCK_MIN: z.coerce.number().int().min(1).max(24 * 60).default(15),
  /** Identité mTLS de la plateforme auprès des Runners (secrets Docker). */
  RUNNER_CLIENT_CERT_FILE: z.string().optional(),
  RUNNER_CLIENT_KEY_FILE: z.string().optional(),
  RUNNER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Archives déposées en attente de transfert (volume dédié, hors image). */
  UPLOAD_DIR: z.string().default('.data/uploads'),
  UPLOAD_MAX_MB: z.coerce.number().int().positive().default(512),
  ZIP_MAX_FILES: z.coerce.number().int().positive().default(20_000),
  ZIP_TIMEOUT_SEC: z.coerce.number().int().positive().max(600).default(120),
  /** API GitHub joignables (séparées par des virgules) : aucune autre URL ne peut être utilisée par un projet. */
  GITHUB_ALLOWED_API_URLS: z.string().default('https://api.github.com'),
  GITHUB_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /** Image Watchtower injectée dans les stacks (fork maintenu, compatible Docker 29). */
  /** Image par défaut du sidecar Watchtower (l'administration peut en figer une autre, page Mises à jour d'images). */
  WATCHTOWER_IMAGE: z.string().default('nickfedor/watchtower:1.23.0'),
  /** URL de la plateforme vue depuis les serveurs cibles (notifications Watchtower) ; défaut : APP_URL. */
  WATCHTOWER_HOOK_BASE_URL: z.url().optional().transform(u => (u === undefined ? undefined : trimTrailingSlashes(u))),
  /** Envoi des emails (§18). Sans SMTP_HOST, les canaux email sont refusés. */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** true : TLS implicite (465) ; sinon STARTTLS exigé hors développement. */
  SMTP_SECURE: z.stringbool().default(false),
  SMTP_USER: z.string().optional(),
  /** Mot de passe SMTP lu dans un fichier (secret Docker), jamais dans l'environnement. */
  SMTP_PASSWORD_FILE: z.string().optional(),
  SMTP_FROM: z.string().default('Sherpa <noreply@localhost>'),
  /** Hôtes autorisés pour les webhooks Teams (motifs *.domaine acceptés), séparés par des virgules. */
  NOTIFY_WEBHOOK_ALLOWED_HOSTS: z.string().default('*.webhook.office.com,*.logic.azure.com,*.api.powerplatform.com,hooks.slack.com,discord.com,discordapp.com,ntfy.sh'),
  NOTIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Défi ACME DNS-01 : attente de la propagation de l'enregistrement TXT (secondes, résolveurs publics). */
  ACME_DNS_PROPAGATION_SEC: z.coerce.number().int().min(0).max(900).default(120),
  /** API Cloudflare (mandataire d'entreprise, banc de test) ; vide : api.cloudflare.com. */
  ACME_DNS_CLOUDFLARE_API: z.preprocess(v => (v === '' ? undefined : v), z.url().optional()),
  /** Reconstruction automatique : intervalle de vérification des nouvelles versions (minutes). */
  AUTO_REBUILD_INTERVAL_MIN: z.coerce.number().int().min(1).max(1440).default(10),
  /** Connecteurs GitHub : intervalle des relevés (minutes). */
  GITHUB_SCAN_INTERVAL_MIN: z.coerce.number().int().min(5).max(10_080).default(60),
  RETENTION_DAYS: z.coerce.number().int().min(1).default(183),
  /** Historique des ressources des conteneurs (relevé chaque minute) : jours conservés. */
  METRICS_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
})

export type Env = z.infer<typeof schema>

let cached: Env | undefined

export function env(): Env {
  if (!cached) {
    // Variable vide = non définie (Compose transmet "" pour ${VAR:-}).
    const parsed = schema.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')))
    if (!parsed.success) {
      throw new Error(`Configuration invalide : ${z.prettifyError(parsed.error)}`)
    }
    if (parsed.data.NODE_ENV === 'production' && parsed.data.DEV_AUTH_BYPASS) {
      throw new Error('DEV_AUTH_BYPASS est interdit en production')
    }
    if (parsed.data.NODE_ENV === 'production' && parsed.data.DATABASE_URL === DEV_DATABASE_URL) {
      throw new Error('DATABASE_URL doit être renseignée en production (la connexion de développement est refusée)')
    }
    const e = parsed.data
    if (e.DATABASE_PASSWORD_FILE) e.DATABASE_URL = withPassword(e.DATABASE_URL, e.DATABASE_PASSWORD_FILE)
    if (e.REDIS_PASSWORD_FILE) e.REDIS_URL = withPassword(e.REDIS_URL, e.REDIS_PASSWORD_FILE)
    if (e.NODE_ENV === 'production' && (!e.APP_URL.startsWith('https://') || !e.COOKIE_SECURE)) {
      console.warn('[configuration] Production sans HTTPS (APP_URL) ou sans cookie Secure (COOKIE_SECURE) : à réserver aux essais')
    }
    cached = e
  }
  return cached
}

/** Réservé aux tests. */
export function resetEnvCache(): void {
  cached = undefined
}

function withPassword(url: string, file: string): string {
  const u = new URL(url)
  u.password = encodeURIComponent(readFileSync(file, 'utf8').trim())
  return u.toString()
}
