#!/usr/bin/env node
/**
 * sherpa : ligne de commande de la console Sherpa (déployer, suivre, lire les logs).
 * Un seul fichier, sans dépendance, Node 18 ou plus. Authentification par jeton d'API (page « Mon compte »).
 *
 *   curl -fsSL https://<console>/cli/sherpa.mjs -o sherpa && chmod +x sherpa
 *   SHERPA_URL=https://<console> SHERPA_TOKEN=shp_… ./sherpa deploy mon-projet --env production --wait
 *
 * Codes de sortie : 0 réussi, 1 déploiement ou requête en échec, 2 usage, 3 délai dépassé.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const VERSION = '1.0.0'

/** Retire les « / » de fin (boucle linéaire : /\/+$/ est quadratique sur une longue suite de « / »). */
const trimSlashes = (s) => {
  let end = s.length
  while (end > 0 && s[end - 1] === '/') end--
  return s.slice(0, end)
}

const TERMINAL_OK = ['HEALTHY']
const TERMINAL_KO = ['DEGRADED', 'FAILED', 'ROLLED_BACK', 'VALIDATION_FAILED', 'CANCELLED']
const STATUS_LABEL = { QUEUED: 'en file', VALIDATING: 'validation', PREPARING_FILES: 'préparation des fichiers', BUILDING: 'construction des images', DEPLOYING: 'déploiement de la stack', HEALTH_CHECKING: 'vérification de santé', HEALTHY: 'opérationnel', DEGRADED: 'dégradé', FAILED: 'échec', ROLLING_BACK: 'retour arrière', ROLLED_BACK: 'retour à la version précédente', VALIDATION_FAILED: 'validation refusée', CANCELLED: 'annulé' }

const HELP = `sherpa ${VERSION} : ligne de commande de la console Sherpa

Usage : sherpa <commande> [options]

Commandes
  login --url <adresse> --token <jeton>   enregistre l'accès dans ~/.config/sherpa/config.json
  whoami                                  compte du jeton et droits
  projects                                projets visibles
  status <projet> [--env <clé>]           état des environnements d'un projet
  deploy <projet> [--env <clé>]           reconstruit sur la dernière version de la source et déploie
      --clean       images de base récupérées à nouveau, sans cache
      --force       redéployer même si la version est déjà en service
      --wait        attendre la fin du déploiement (code 1 si échec) ; --no-wait pour ne pas attendre
      --timeout <s> délai d'attente (défaut 1800)
  logs <id-déploiement> [--follow]        journal d'un déploiement
  version

Options générales
  --url <adresse>   console (sinon SHERPA_URL ou ~/.config/sherpa/config.json)
  --token <jeton>   jeton d'API (sinon SHERPA_TOKEN ; de préférence la variable, pas l'historique du shell)
  --json            sortie JSON (status, projects, whoami, deploy)
  --insecure        ne pas vérifier le certificat TLS (déconseillé ; sinon NODE_EXTRA_CA_CERTS)
`

class CliError extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

/** Arguments : `--clé valeur`, `--drapeau`, `--no-drapeau`, positionnels. */
export function parseArgs(argv) {
  const flags = {}
  const positional = []
  const BOOL = new Set(['clean', 'force', 'wait', 'json', 'insecure', 'follow', 'help', 'version', 'h'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h') flags.help = true
    else if (a.startsWith('--no-')) flags[a.slice(5)] = false
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else if (BOOL.has(a.slice(2))) flags[a.slice(2)] = true
      else {
        const v = argv[i + 1]
        if (v === undefined || v.startsWith('--')) throw new CliError(`Valeur manquante pour ${a}`, 2)
        flags[a.slice(2)] = v
        i++
      }
    }
    else positional.push(a)
  }
  return { flags, positional }
}

const configPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'sherpa', 'config.json')
function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'))
  }
  catch {
    return {}
  }
}

/** Accès : options, puis variables d'environnement, puis fichier de configuration. */
export function resolveAccess(flags, env = process.env, file = readConfig()) {
  const url = trimSlashes(String(flags.url ?? env.SHERPA_URL ?? file.url ?? ''))
  const token = String(flags.token ?? env.SHERPA_TOKEN ?? file.token ?? '')
  if (!url) throw new CliError('Console inconnue : --url, SHERPA_URL ou « sherpa login »', 2)
  if (!/^https?:\/\//.test(url)) throw new CliError(`Adresse invalide : ${url}`, 2)
  if (!token.startsWith('shp_')) throw new CliError('Jeton d\'API absent ou invalide (shp_…) : --token, SHERPA_TOKEN ou « sherpa login »', 2)
  return { url, token }
}

function client({ url, token }) {
  return async function call(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
    let res
    try {
      res = await fetch(`${url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': `sherpa-cli/${VERSION}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      })
    }
    catch (err) {
      throw new CliError(`Console injoignable (${url}) : ${err.cause?.code ?? err.message}`)
    }
    const text = await res.text()
    if (!res.ok) {
      let message = text.slice(0, 300)
      try {
        const j = JSON.parse(text)
        message = j.statusMessage ?? j.message ?? message
      }
      catch { /* texte brut */ }
      throw new CliError(`${res.status === 401 ? 'Jeton refusé' : res.status === 403 ? 'Droit insuffisant' : `Erreur ${res.status}`} : ${message}`)
    }
    return raw ? text : (text ? JSON.parse(text) : null)
  }
}

const out = (s = '') => process.stdout.write(`${s}\n`)
const err = (s = '') => process.stderr.write(`${s}\n`)
const fmtDur = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length)))
  const line = r => r.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd()
  out(line(headers))
  for (const r of rows) out(line(r))
}

async function findProject(call, slug) {
  const r = await call(`/api/projects?q=${encodeURIComponent(slug)}&pageSize=50`)
  const p = (r.items ?? []).find(x => x.slug === slug) ?? (r.items ?? []).find(x => x.name === slug)
  if (!p) throw new CliError(`Projet « ${slug} » introuvable (ou non autorisé pour ce jeton)`)
  return call(`/api/projects/${p.id}`)
}

function pickTarget(project, env) {
  const targets = project.targets ?? []
  if (!targets.length) throw new CliError(`Le projet ${project.slug} n'a aucun environnement`)
  if (!env) {
    if (targets.length > 1) throw new CliError(`Plusieurs environnements : préciser --env (${targets.map(t => t.environment.key).join(', ')})`, 2)
    return targets[0]
  }
  const t = targets.find(x => x.environment.key === env)
  if (!t) throw new CliError(`Environnement « ${env} » inconnu pour ${project.slug} (${targets.map(x => x.environment.key).join(', ')})`, 2)
  return t
}

async function tailLogs(call, id, n = 15) {
  const text = await call(`/api/deployments/${id}/logs?format=text`, { raw: true }).catch(() => '')
  return text.split('\n').filter(l => / (WARN|ERROR) /.test(l) || /Statut :/.test(l)).slice(-n)
}

/** Attend la fin d'un déploiement ; renvoie son statut final. */
async function waitDeployment(call, id, { timeoutS, json }) {
  const started = Date.now()
  let last = ''
  for (;;) {
    const d = await call(`/api/deployments/${id}`)
    if (d.status !== last) {
      last = d.status
      if (!json) out(`[${fmtDur(Math.round((Date.now() - started) / 1000))}] ${STATUS_LABEL[d.status] ?? d.status}`)
    }
    if (TERMINAL_OK.includes(d.status) || TERMINAL_KO.includes(d.status)) return d
    if (Date.now() - started > timeoutS * 1000) throw new CliError(`Délai dépassé (${timeoutS} s) : le déploiement continue sur la console (statut ${d.status})`, 3)
    await sleep(3000)
  }
}

const commands = {
  async login(flags) {
    const url = trimSlashes(String(flags.url ?? ''))
    const token = String(flags.token ?? '')
    if (!/^https?:\/\//.test(url) || !token.startsWith('shp_')) throw new CliError('Usage : sherpa login --url https://console --token shp_…', 2)
    const me = await client({ url, token })('/api/auth/me')
    if (!me?.authenticated) throw new CliError('Jeton refusé par la console')
    const path = configPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ url, token }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    out(`Connecté à ${url} en tant que ${me.user.email}\nAccès enregistré dans ${path}`)
  },

  async whoami(flags, _pos, call) {
    const me = await call('/api/auth/me')
    if (flags.json) return out(JSON.stringify(me, null, 2))
    out(`${me.user.email}\nDroits : ${me.permissions.join(', ') || 'aucun'}`)
  },

  async projects(flags, _pos, call) {
    const r = await call('/api/projects?pageSize=100')
    if (flags.json) return out(JSON.stringify(r.items, null, 2))
    table((r.items ?? []).map(p => [p.slug, p.name, p.targetCount, p.lastStatus ?? '—']), ['PROJET', 'NOM', 'ENV.', 'DERNIER ÉTAT'])
  },

  async status(flags, pos, call) {
    if (!pos[0]) throw new CliError('Usage : sherpa status <projet> [--env <clé>]', 2)
    const project = await findProject(call, pos[0])
    const targets = flags.env ? [pickTarget(project, flags.env)] : project.targets
    if (flags.json) return out(JSON.stringify(targets, null, 2))
    table(targets.map(t => [t.environment.key, t.currentRelease ? `#${t.currentRelease.number}` : '—', t.lastDeployment ? `${STATUS_LABEL[t.lastDeployment.status] ?? t.lastDeployment.status} (${t.lastDeployment.action})` : '—', t.server.name]), ['ENVIRONNEMENT', 'RELEASE', 'DERNIER DÉPLOIEMENT', 'SERVEUR'])
  },

  async deploy(flags, pos, call, access) {
    if (!pos[0]) throw new CliError('Usage : sherpa deploy <projet> [--env <clé>] [--wait]', 2)
    const project = await findProject(call, pos[0])
    const target = pickTarget(project, flags.env)
    const plan = await call(`/api/targets/${target.id}/rebuild`)
    if (!flags.json) out(`${project.name} (${target.environment.name}) : ${plan.current?.label ?? '?'} → ${plan.latest?.label ?? 'même release'}`)
    if (plan.upToDate && !flags.force) {
      if (flags.json) out(JSON.stringify({ deployed: false, reason: 'up-to-date', current: plan.current }))
      else out('Version déjà en service : rien à déployer (--force pour redéployer).')
      return
    }
    const started = await call(`/api/targets/${target.id}/rebuild`, { method: 'POST', body: { cleanBuild: !!flags.clean }, headers: { 'idempotency-key': `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` } })
    const link = `${access.url}/deployments/${started.deploymentId}`
    if (flags.wait === false) {
      if (flags.json) return out(JSON.stringify({ deployed: true, deploymentId: started.deploymentId, url: link }))
      return out(`Déploiement lancé : ${link}`)
    }
    if (!flags.json) out(`Déploiement lancé : ${link}`)
    const timeoutS = Number(flags.timeout ?? 1800)
    const d = await waitDeployment(call, started.deploymentId, { timeoutS, json: !!flags.json })
    const ok = TERMINAL_OK.includes(d.status)
    if (flags.json) out(JSON.stringify({ deployed: ok, status: d.status, deploymentId: d.id, url: link, error: d.error }))
    else if (ok) out(`Terminé : ${STATUS_LABEL[d.status]}`)
    else {
      err(`Échec : ${STATUS_LABEL[d.status] ?? d.status}${d.error ? ` — ${d.error}` : ''}`)
      for (const l of await tailLogs(call, d.id)) err(`  ${l}`)
      err(`Détail : ${link}`)
    }
    if (!ok) throw new CliError('', 1)
  },

  async logs(flags, pos, call) {
    if (!pos[0]) throw new CliError('Usage : sherpa logs <id-déploiement> [--follow]', 2)
    const id = pos[0]
    if (!flags.follow) return out((await call(`/api/deployments/${id}/logs?format=text`, { raw: true })).trimEnd())
    let after = '0'
    for (;;) {
      const page = await call(`/api/deployments/${id}/logs?afterId=${after}&limit=500`)
      for (const l of page.lines) out(`${l.ts} ${String(l.level).toUpperCase().padEnd(5)} [${l.phase}${l.service ? `/${l.service}` : ''}] ${l.message}`)
      if (page.lines.length) after = page.lines.at(-1).id
      if (!page.hasMore) {
        const d = await call(`/api/deployments/${id}`)
        if (TERMINAL_OK.includes(d.status) || TERMINAL_KO.includes(d.status) || ['STOPPED', 'DELETED'].includes(d.status)) return
        await sleep(2000)
      }
    }
  },
}

export async function main(argv) {
  const { flags, positional } = parseArgs(argv)
  const [name, ...rest] = positional
  if (flags.version || name === 'version') return out(`sherpa ${VERSION}`)
  if (flags.help || !name || name === 'help') return out(HELP)
  if (!commands[name]) throw new CliError(`Commande inconnue : ${name}\n\n${HELP}`, 2)
  if (flags.insecure) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    err('Attention : certificat TLS non vérifié')
  }
  if (name === 'login') return commands.login(flags)
  const access = resolveAccess(flags)
  return commands[name](flags, rest, client(access), access)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (Number(process.versions.node.split('.')[0]) < 18) {
    err('Node 18 ou plus est requis')
    process.exit(2)
  }
  main(process.argv.slice(2)).catch((e) => {
    if (e.message) err(e instanceof CliError ? e.message : `Erreur : ${e.message}`)
    process.exit(e instanceof CliError ? e.code : 1)
  })
}

// Utilisé par les tests : fichier de configuration présent ?
export const _configExists = () => existsSync(configPath())
