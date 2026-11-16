/**
 * Rapport « tech support » d'une cible, en texte brut : identité, état, diagnostic, conteneurs,
 * réseaux, configuration (Compose final, surcharges, variables, chemins, Watchtower), déploiements
 * récents et journaux. Aucun secret : valeurs des variables secrètes masquées partout, valeurs de
 * l'environnement des conteneurs jamais incluses, motifs sensibles (jetons, mots de passe) masqués.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { createError } from 'h3'
import type { AuthUser } from '../utils/auth'
import { Redactor, redactObject, redactPatterns } from '../utils/redact'
import type { ContainerConfig, NetworkDetail } from '../adapters/portainer/types'
import { DNS_TIMEOUT_S, HTTP_TIMEOUT_S, PROBE_OUTPUT, hostnamesFromEnv, httpUrlsOf, isBenignSecret, parseProbe, probeScript } from '../lib/network-probe'
import { env } from '../utils/env'
import { WORKER_HEARTBEAT_KEY, deploymentQueue, maintenanceQueue, notificationQueue } from '../queue/queues'
import { redis } from '../queue/redis'
import { getUpdateEngine } from './update-engine'
import { addressPlan } from './address-plan'
import { liveEndpoints } from './live'
import { getManagedProxy } from './managed-proxy'
import { endpointTopology } from './proxy'
import { toRunnerDto } from './runner-admin'
import { listProfiles } from './watchtower-profiles'
import { diagnoseTarget, stackOfTarget } from './diagnostic'
import { type TargetRow, targetVariables } from './projects'
import { connectionFor, environmentMaps } from './servers'
import { byCode } from '../../shared/utils/compare'

const SERVICE_LOG_LINES = 100
const HELPER_IMAGE = process.env.HOST_HELPER_IMAGE || 'busybox:1.37'

const hcTimings = (hc: NonNullable<ContainerConfig['healthcheck']>) => {
  const sec = (ns: number | null) => (ns ? `${ns / 1e9} s` : null)
  const parts = [['intervalle', sec(hc.intervalNs)], ['délai', sec(hc.timeoutNs)], ['essais', hc.retries ? String(hc.retries) : null], ['démarrage', sec(hc.startPeriodNs)]].filter(([, v]) => v)
  return parts.length ? ` · ${parts.map(([k, v]) => `${k} ${v}`).join(' · ')}` : ''
}
const DEPLOY_LOG_LINES = 200

export async function techSupportReport(t: TargetRow, opts: { logs: boolean, by: string }): Promise<string> {
  const vars = await targetVariables(t.target)
  const redactor = new Redactor()
  // Valeurs publiques (projet, environnement, services, images, hôtes exposés) jamais masquées,
  // même saisies dans une variable secrète : sinon le nom du projet disparaît de tout le rapport.
  const [relImages] = t.target.currentReleaseId ? await db().select({ images: schema.releases.images }).from(schema.releases).where(eq(schema.releases.id, t.target.currentReleaseId)) : []
  const hosts = (t.target.exposures as { host?: string | null }[] | null ?? []).map(e => e.host).filter((h): h is string => !!h)
  const publicValues = new Set([t.project.slug, t.project.name, t.env.key, t.env.name, stackOfTarget(t), ...Object.keys(relImages?.images as Record<string, string> ?? {}), ...Object.values(relImages?.images as Record<string, string> ?? {}), ...hosts, ...hosts.flatMap(h => [`https://${h}`, `http://${h}`])])
  for (const v of Object.values(vars)) if (v.secret && !isBenignSecret(v.value, publicValues)) redactor.add(v.value)
  const out: string[] = []
  const line = (s = '') => out.push(s)
  const section = (title: string) => {
    line()
    line(`=== ${title} ${'='.repeat(Math.max(3, 74 - title.length))}`)
  }
  const kv = (k: string, v: unknown) => line(`${k.padEnd(24)} ${v === null || v === undefined || v === '' ? '—' : String(v)}`)
  const guard = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn()
    }
    catch (err) {
      line(`(${label} indisponible : ${(err as Error).message.slice(0, 300)})`)
    }
  }

  line(`TECH SUPPORT — ${t.project.name} (${t.project.slug}) / ${t.env.name}`)
  kv('Généré le', new Date().toISOString())
  kv('Par', opts.by)
  kv('Console', process.env.APP_REVISION ?? 'dev')

  // --- Cible ---
  const stack = stackOfTarget(t)
  const [server] = await db().select().from(schema.portainerServers).where(eq(schema.portainerServers.id, t.server.id))
  section('Cible')
  kv('Projet', `${t.project.name} (${t.project.slug})`)
  kv('Environnement', `${t.env.name} (${t.env.key})${t.env.isProduction ? ', production' : ''}`)
  kv('Serveur / endpoint', `${t.server.name} / ${t.endpoint.name}`)
  kv('Accès', server?.transport === 'ssh' ? `SSH ${server.sshUser ?? ''}@${server.sshHost ?? ''}:${server.sshPort ?? 22}` : `agent ${server?.url ?? ''}`)
  kv('Stack', `${stack}${t.target.portainerStackId ? ` (#${t.target.portainerStackId})` : ' (non déployée)'}`)
  kv('Chemin du projet', t.target.projectPath)
  kv('Rollback automatique', t.target.autoRollback ? 'oui' : 'non')
  kv('Délai des healthchecks', `${t.target.healthTimeoutSec} s`)
  kv('Santé constatée', t.target.healthState ? JSON.stringify(t.target.healthState) : null)
  kv('Action en attente', t.target.pendingAction ? JSON.stringify(t.target.pendingAction) : null)

  // --- Release active ---
  const [rel] = t.target.currentReleaseId ? await db().select().from(schema.releases).where(eq(schema.releases.id, t.target.currentReleaseId)) : []
  section('Release active')
  if (!rel) line('Aucune release active')
  else {
    kv('Release', `#${rel.number} ${rel.slug ?? ''}`)
    kv('Source', rel.sourceKind === 'github' ? `GitHub ${rel.repository ?? ''}@${rel.commitSha ?? ''}` : rel.sourceKind)
    kv('Compose', rel.composePath)
    kv('Archive (sha256)', rel.archiveSha256)
    kv('Activée le', rel.activatedAt?.toISOString())
    for (const [svc, img] of Object.entries(rel.images as Record<string, string>)) kv(`  image ${svc}`, img)
  }

  // --- Diagnostic ---
  section('Diagnostic')
  await guard('Diagnostic', async () => {
    const d = await diagnoseTarget(t, { logs: opts.logs })
    line(`Synthèse : [${d.summary.severity}] ${d.summary.title}${d.summary.detail ? ` — ${d.summary.detail}` : ''}`)
    for (const s of d.services) {
      line()
      line(`- ${s.service} : ${s.state}${s.health ? ` (${s.health})` : ''} · image ${s.image ?? '—'} · redémarrages ${s.restartCount}${s.exitCode !== null ? ` · code de sortie ${s.exitCode}` : ''}${s.oomKilled ? ' · tué (mémoire)' : ''}`)
      for (const f of s.findings) line(`    [${f.severity}] ${f.title}${f.detail ? ` — ${redactor.redact(f.detail)}` : ''}`)
      for (const h of s.healthLog) line(`    healthcheck ${h.at} code ${h.exitCode} : ${redactor.redact(h.output).replace(/\s+/g, ' ').slice(0, 300)}`)
    }
  })

  // --- Conteneurs et réseaux ---
  const notes: string[] = []
  section('Conteneurs (hôte)')
  await guard('Lecture de l\'hôte', async () => {
    const conn = await connectionFor(server!)
    const p = portainer()
    const epId = t.endpoint.portainerEndpointId
    const containers = await p.stackContainers(conn, epId, stack)
    if (!containers.length) line('Aucun conteneur pour cette stack')
    const networks = new Set<string>()
    const infos: { c: (typeof containers)[number], cfg: ContainerConfig | null }[] = []
    for (const c of containers) {
      const cfg = await p.inspectConfig(conn, epId, c.id).catch(() => null)
      infos.push({ c, cfg })
      line()
      line(`- ${c.name} (${c.service ?? '—'})`)
      kv('    image', `${c.image} ${c.imageId ?? ''}`)
      kv('    état', `${c.status}${c.health ? ` (${c.health})` : ''} · démarré ${c.startedAt ?? '—'} · redémarrages ${c.restartCount}`)
      if (cfg) {
        kv('    ports', cfg.portBindings.map(b => `${b.hostIp ?? ''}:${b.hostPort ?? ''}->${b.container}`).join(', '))
        kv('    réseaux', cfg.networks.map(n => `${n.name}${n.aliases.length ? ` [${n.aliases.join(', ')}]` : ''}`).join(' ; '))
        kv('    montages', cfg.mounts.map(m => `${m.name ?? m.source}:${m.destination}${m.rw ? '' : ':ro'}`).join(' ; '))
        kv('    redémarrage', cfg.restartPolicy)
        const hc = cfg.healthcheck
        kv('    healthcheck', hc ? `${redactor.redact(hc.test.join(' '))}${hcTimings(hc)}` : null)
        // Environnement : noms seulement (les valeurs peuvent être des secrets).
        kv('    environnement', cfg.env.map(e => e.split('=')[0]!).sort(byCode).join(', '))
        for (const n of cfg.networks) networks.add(n.name)
      }
    }

    // Réseaux : sous-réseaux, et index des adresses (qui répond à quelle IP, sur quel réseau).
    section('Réseaux de la stack')
    const stackIds = new Set(containers.map(c => c.id))
    const byIp = new Map<string, { name: string, network: string, inStack: boolean }>()
    const details: NetworkDetail[] = []
    for (const name of [...networks].sort(byCode)) {
      const n = await p.inspectNetwork(conn, epId, name).catch(() => null)
      line(`- ${name} : ${n ? `${n.driver}${n.internal ? ', interne' : ''} · ${n.ipam.config.map(c => c.subnet).join(', ') || 'sous-réseau inconnu'} · ${n.containers.length} conteneur(s)${n.containers.some(c => !stackIds.has(c.id)) ? `, dont ${n.containers.filter(c => !stackIds.has(c.id)).length} hors stack (réseau partagé)` : ''}` : 'illisible'}`)
      if (!n) continue
      details.push(n)
      for (const c of n.containers) if (c.ipv4) byIp.set(c.ipv4.split('/')[0]!, { name: c.name, network: name, inStack: stackIds.has(c.id) })
    }

    // Nom du service absent de ses alias sur un réseau (conteneur rebranché sans alias) : injoignable par son nom.
    for (const { c, cfg } of infos) {
      if (!c.service || !cfg) continue
      for (const n of cfg.networks) {
        if (n.aliases.includes(c.service) || !details.some(d => d.name === n.name)) continue
        notes.push(`${c.name} n'a pas l'alias « ${c.service} » sur ${n.name} : les autres services ne le joignent pas par ce nom. Redéployer (« Redéployer », pas « Redémarrer ») pour recréer le conteneur avec ses alias.`)
      }
    }

    // Noms que la stack s'attend à joindre : ses services, et les hôtes cités par l'environnement.
    const services = [...new Set(containers.map(c => c.service).filter((s): s is string => !!s))].sort(byCode)
    const wantedOf = (cfg: ContainerConfig | null) => [...new Set([...services, ...hostnamesFromEnv(cfg?.env ?? [])])].slice(0, 20)
    const wanted = new Set(infos.flatMap(i => wantedOf(i.cfg)))

    section('Réseau : homonymes sur les réseaux partagés')
    let shared = 0
    for (const n of details) {
      const foreign = n.containers.filter(c => !stackIds.has(c.id)).slice(0, 80)
      if (!foreign.length) continue
      shared++
      const members = infos.filter(i => i.cfg?.networks.some(x => x.name === n.name)).map(i => i.c.service ?? i.c.name)
      const hits: string[] = []
      for (const f of foreign) {
        const cfg = await p.inspectConfig(conn, epId, f.id).catch(() => null)
        const names = new Set([f.name, ...(cfg?.networks.find(x => x.name === n.name)?.aliases ?? [])].map(x => x.toLowerCase()))
        const project = cfg?.labels['com.docker.compose.project']
        for (const w of wanted) {
          if (!names.has(w)) continue
          hits.push(w)
          const where = `${n.name} : « ${redactor.redact(w)} » est aussi porté par ${f.name}${project ? ` (stack ${project})` : ''}`
          // Gênant seulement si un service branché ici cite ce nom dans son environnement.
          const users = infos.filter(i => i.cfg?.networks.some(x => x.name === n.name) && hostnamesFromEnv(i.cfg.env).includes(w)).map(i => i.c.service ?? i.c.name)
          if (users.length) {
            line(`⚠ ${where} — ${users.join(', ')} l'utilise et peut joindre ce conteneur à la place du service de la stack`)
            notes.push(`Homonyme sur le réseau partagé ${n.name} : « ${redactor.redact(w)} » répond aussi pour ${f.name}${project ? ` (stack ${project})` : ''}, et ${users.join(', ')} l'utilise. Redéployer : la plateforme donne aux services des alias uniques (${stack}-<service>) et les substitue dans les URL de connexion.`)
          }
          else line(`- ${where} — sans effet : aucun service branché ici ne l'utilise (${members.join(', ')} passe par les alias uniques)`)
        }
      }
      if (!hits.length) line(`- ${n.name} : ${foreign.length} conteneur(s) hors stack, aucun ne porte un nom utilisé par la stack (${[...wanted].map(w => redactor.redact(w)).join(', ') || '—'})`)
    }
    if (!shared) line('Aucun réseau partagé avec d\'autres conteneurs')

    // Sondes dans l'espace réseau de chaque conteneur : résolution des noms et temps de réponse réels.
    section('Réseau : résolution des noms vue par chaque conteneur')
    const measures: { svc: string, url: string, seconds: number | null, exitCode: number, error: string, timeoutS: number | null }[] = []
    // Sondes lancées en parallèle (une route bloquée ne retarde pas les autres), lues dans l'ordre.
    const probes = infos.map(({ c, cfg }) => {
      if (c.status !== 'running' || !cfg) return null
      const names = wantedOf(cfg)
      const exposed = (t.target.exposures as { service: string, port: number }[] | null ?? []).filter(e => e.service === c.service).map(e => e.port)
      const hcUrls = cfg.healthcheck ? httpUrlsOf(cfg.healthcheck.test) : []
      const urls = [...hcUrls, ...exposed.filter(port => !hcUrls.some(u => u.includes(`:${port}/`) || u.endsWith(`:${port}`))).map(port => `http://127.0.0.1:${port}/`)].slice(0, 4)
      const run = p.runOneShot(conn, epId, {
        image: HELPER_IMAGE,
        entrypoint: ['sh', '-c'],
        cmd: [probeScript(names, urls)],
        binds: [],
        files: [],
        outputs: [PROBE_OUTPUT],
        outputLimits: { maxBytes: 64 * 1024, maxFiles: 1 },
        labels: { 'platform.managed': 'true', 'platform.probe': 'tech-support' },
        timeoutMs: (names.length * (DNS_TIMEOUT_S + 1) + HTTP_TIMEOUT_S + 40) * 1000,
        memoryMb: 64,
        networkMode: `container:${c.id}`,
      })
      run.catch(() => {})
      return { names, urls, run }
    })
    for (const [idx, { c, cfg }] of infos.entries()) {
      const svc = c.service ?? c.name
      line()
      line(`- ${svc} (${c.name})`)
      const probe = probes[idx]
      if (!probe || !cfg) {
        line('    non démarré : sonde impossible')
        continue
      }
      const { names, urls } = probe
      try {
        const r = await probe.run
        const res = parseProbe(r.outputs[PROBE_OUTPUT]?.[0]?.content ?? '', names, urls)
        for (const d of res.dns) {
          const who = d.addresses.map((a) => {
            const o = byIp.get(a)
            return o ? `${a} (${o.name} · ${o.network}${o.inStack ? '' : ', hors stack'})` : `${a} (hors réseaux de la stack)`
          })
          const used = hostnamesFromEnv(cfg.env).includes(d.name)
          const foreign = used ? d.addresses.filter(a => byIp.get(a) && !byIp.get(a)!.inStack) : []
          const isService = services.includes(d.name)
          const flag = foreign.length ? ' ⚠ HOMONYME (nom utilisé par le service)' : d.addresses.some(a => byIp.get(a) && !byIp.get(a)!.inStack) ? ' (homonyme sans effet : nom non utilisé)' : d.addresses.length > 1 ? ' (plusieurs réponses)' : d.status !== 'ok' && isService ? ' ⚠' : ''
          const nm = redactor.redact(d.name)
          line(`    ${nm} → ${d.status === 'ok' ? who.join(', ') : d.status === 'not_found' ? 'introuvable' : d.status === 'timeout' ? `pas de réponse en ${DNS_TIMEOUT_S} s` : `erreur${d.detail ? ` (${redactor.redact(d.detail)})` : ''}`}${flag}`)
          if (foreign.length) notes.push(`${svc} résout « ${nm} » vers ${foreign.map(a => `${byIp.get(a)!.name} (${byIp.get(a)!.network})`).join(', ')}, hors de la stack : il peut joindre le mauvais service.`)
          else if (d.status !== 'ok' && isService) notes.push(`${svc} ne résout pas le service « ${nm} » (${d.status === 'timeout' ? 'DNS sans réponse' : 'introuvable'}) : réseau commun manquant, ou alias du service absent (voir ci-dessus).`)
        }
        if (!names.length) line('    aucun nom à résoudre')
        for (const h of res.http) measures.push({ svc, ...h, timeoutS: cfg.healthcheck?.timeoutNs ? cfg.healthcheck.timeoutNs / 1e9 : null })
      }
      catch (err) {
        line(`    sonde impossible : ${redactor.redact((err as Error).message).slice(0, 300)}`)
      }
    }

    section('Santé : temps de réponse mesurés (depuis le conteneur)')
    if (!measures.length) line('Aucune URL HTTP à mesurer (healthcheck sans URL, aucune exposition)')
    for (const m of measures) {
      const url = redactor.redact(m.url)
      const took = m.seconds === null ? '—' : `${m.seconds.toFixed(2).replace('.', ',')} s`
      const ok = m.exitCode === 0
      const timedOut = !ok && (m.exitCode === 143 || m.exitCode === 124 || (m.seconds ?? 0) >= HTTP_TIMEOUT_S - 1)
      const verdict = ok ? 'répond' : timedOut ? `aucune réponse en ${HTTP_TIMEOUT_S} s` : `échec (code ${m.exitCode})${m.error ? ` : ${redactor.redact(m.error)}` : ''}`
      line(`- ${m.svc} ${url} → ${verdict} · ${took}${m.timeoutS ? ` · délai du healthcheck ${m.timeoutS} s` : ''}`)
      if (timedOut) notes.push(`${m.svc} : ${url} ne répond pas en ${HTTP_TIMEOUT_S} s — l'application est bloquée, souvent sur une dépendance (base, cache, service externe) : voir la résolution des noms ci-dessous.`)
      else if (ok && m.timeoutS && m.seconds !== null && m.seconds > m.timeoutS) notes.push(`${m.svc} : ${url} répond en ${took}, au-delà du délai du healthcheck (${m.timeoutS} s) — allonger le délai ou alléger la route de santé.`)
      else if (!ok && m.exitCode !== -1) notes.push(`${m.svc} : ${url} en échec (${verdict}) après ${took}.`)
      else if (ok && infos.find(i => (i.c.service ?? i.c.name) === m.svc)?.c.health === 'unhealthy') notes.push(`${m.svc} : ${url} répond en ${took} maintenant alors que le conteneur est « unhealthy » — problème intermittent, ou commande du healthcheck en cause (outil absent de l'image ?).`)
    }
  })

  // Constats tirés des sondes, placés juste après le diagnostic.
  const at = out.findIndex(l => l.startsWith('=== Conteneurs (hôte)')) - 1
  if (at > 0) {
    out.splice(at, 0, '', `=== Constats des sondes ${'='.repeat(74 - 'Constats des sondes'.length)}`, ...(notes.length ? notes.map(n => `- ${n}`) : ['Aucune anomalie réseau ni lenteur détectée par les sondes']))
  }

  // --- Configuration ---
  section('Configuration : variables')
  const names = Object.keys(vars).sort(byCode)
  if (!names.length) line('Aucune variable')
  for (const n of names) line(`${n} = ${vars[n]!.secret ? '•••••• (secrète)' : redactor.redact(vars[n]!.value)}`)

  section('Configuration : surcharges de la cible')
  line(redactor.redact(JSON.stringify(t.target.composeOverrides ?? {}, null, 2)))
  section('Configuration : expositions')
  line(JSON.stringify(t.target.exposures ?? [], null, 2))
  section('Configuration : Watchtower')
  line(JSON.stringify({ wanted: t.target.watchtower, applied: t.target.watchtowerApplied, pausedAt: t.target.watchtowerPausedAt }, null, 2))
  section('Configuration : chemins de l\'endpoint')
  const [paths] = await db().select().from(schema.pathConfigs).where(and(eq(schema.pathConfigs.endpointId, t.endpoint.id), eq(schema.pathConfigs.environmentId, t.env.id)))
  line(paths ? JSON.stringify({ workingRoot: paths.workingRoot, buildRoot: paths.buildRoot, tmpRoot: paths.tmpRoot, runtimeRoot: paths.runtimeRoot, autoCreate: paths.autoCreate, dirMode: paths.dirMode, minFreeDiskMb: paths.minFreeDiskMb, releasesToKeep: paths.releasesToKeep }, null, 2) : 'Non configurés')

  section('Configuration : Compose final (release active)')
  line(rel?.composeFinal ? redactor.redact(rel.composeFinal) : 'Aucun')

  // --- Déploiements ---
  section('Déploiements récents')
  const deps = await db().select().from(schema.deployments).where(eq(schema.deployments.targetId, t.target.id)).orderBy(desc(schema.deployments.createdAt)).limit(10)
  for (const d of deps) {
    const dur = d.finishedAt && d.startedAt ? `${Math.round((d.finishedAt.getTime() - d.startedAt.getTime()) / 1000)} s` : '—'
    line(`- ${d.createdAt.toISOString()} ${d.action.padEnd(9)} ${d.status.padEnd(12)} ${dur.padStart(6)} ${d.id}${d.error ? ` — ${redactor.redact(d.error).slice(0, 300)}` : ''}`)
  }
  if (opts.logs && deps[0]) {
    section(`Journal du dernier déploiement (${deps[0].id.slice(0, 8)}, ${DEPLOY_LOG_LINES} dernières lignes)`)
    const logs = await db().select().from(schema.deploymentLogs).where(eq(schema.deploymentLogs.deploymentId, deps[0].id)).orderBy(desc(schema.deploymentLogs.id)).limit(DEPLOY_LOG_LINES)
    for (const l of logs.reverse()) line(`${l.ts.toISOString()} ${l.level.toUpperCase().padEnd(5)} [${l.phase}${l.service ? `/${l.service}` : ''}] ${redactor.redact(l.message)}`)
  }

  // --- Journaux des services ---
  section(`Journaux des services (${SERVICE_LOG_LINES} dernières lignes)`)
  if (!opts.logs) line('Non inclus : droit de lecture des journaux requis')
  else {
    await guard('Journaux', async () => {
      const conn = await connectionFor(server!)
      const p = portainer()
      for (const c of await p.stackContainers(conn, t.endpoint.portainerEndpointId, stack)) {
        line()
        line(`--- ${c.name} ---`)
        for (const l of await p.containerLogs(conn, t.endpoint.portainerEndpointId, c.id, SERVICE_LOG_LINES).catch(() => [] as string[])) line(redactor.redact(l))
      }
    })
  }
  line()
  line('=== Fin du rapport ===')
  return `${out.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Rapport d'un serveur
// ---------------------------------------------------------------------------

const fmtBytes = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} Go` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} Mo` : `${Math.round(n / 1e3)} ko`)

/**
 * Rapport « tech support » d'un serveur, en texte brut : identité et accès, et pour chaque
 * endpoint moteur Docker, disque, Runner, chemins, règles, Traefik, plan d'adressage, profils
 * Watchtower, reverse proxies, projets et conteneurs ; audit récent. Aucun secret (secret d'agent,
 * clé SSH, identifiants DNS ou de registre) : seulement leur présence.
 */
export async function serverTechSupportReport(serverId: string, user: AuthUser): Promise<string> {
  const out: string[] = []
  const line = (s = '') => out.push(s)
  const section = (title: string) => {
    line()
    line(`=== ${title} ${'='.repeat(Math.max(3, 74 - title.length))}`)
  }
  const kv = (k: string, v: unknown) => line(`${k.padEnd(26)} ${v === null || v === undefined || v === '' ? '—' : String(v)}`)
  const guard = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn()
    }
    catch (err) {
      line(`(${label} indisponible : ${(err as Error).message.slice(0, 300)})`)
    }
  }

  const [s] = await db().select().from(schema.portainerServers).where(eq(schema.portainerServers.id, serverId))
  if (!s) throw createError({ statusCode: 404, statusMessage: 'Serveur introuvable' })
  line(`TECH SUPPORT — serveur ${s.name}`)
  kv('Généré le', new Date().toISOString())
  kv('Par', user.email)
  kv('Console', process.env.APP_REVISION ?? 'dev')

  section('Serveur')
  kv('Nom', s.name)
  kv('Description', s.description)
  kv('Accès', s.transport === 'ssh' ? `SSH ${s.sshUser ?? ''}@${s.sshHost ?? ''}:${s.sshPort ?? 22} (${s.sshAuth === 'key' ? 'clé' : 'mot de passe'}, enregistré chiffré)` : `agent ${s.url} (AGENT_SECRET enregistré chiffré)`)
  if (s.transport === 'ssh') {
    kv('Clé d\'hôte confirmée', s.sshHostKey ? `${s.sshHostKey} (${s.sshHostKeyType ?? '?'})` : 'non confirmée')
    kv('Socket Docker', s.dockerSocket)
  }
  else kv('Vérification TLS', `${s.tlsVerify ? 'oui' : 'non'}${s.caCertPem ? ', AC fournie' : ''}`)
  kv('Version détectée', s.detectedVersion)
  kv('Statut', s.status)
  kv('Dernier contrôle', s.lastCheckedAt?.toISOString())
  kv('Dernière découverte', s.lastDiscoveryAt?.toISOString())
  kv('Dernière erreur', s.lastError)
  kv('Étiquettes', s.tags.join(', '))
  kv('Capacités', Object.entries(s.capabilities ?? {}).filter(([, v]) => v).map(([k]) => k).join(', '))

  const conn = await connectionFor(s).catch(() => null)
  const endpoints = await db().select().from(schema.serverEndpoints).where(eq(schema.serverEndpoints.serverId, serverId)).orderBy(schema.serverEndpoints.name)
  const { keyById } = await environmentMaps()
  for (const ep of endpoints) {
    const epId = ep.portainerEndpointId
    section(`Endpoint ${ep.name}`)
    kv('Type', ep.type)
    kv('Activé', ep.enabled ? 'oui' : 'non')
    kv('Disparu', ep.missing ? 'oui' : 'non')
    const envs = await db().select({ id: schema.endpointEnvironments.environmentId }).from(schema.endpointEnvironments).where(eq(schema.endpointEnvironments.endpointId, ep.id))
    kv('Environnements', envs.map(e => keyById.get(e.id)).join(', '))
    kv('Inventaire', JSON.stringify(ep.inventory))

    line()
    line('--- Moteur Docker ---')
    await guard('Moteur', async () => {
      const i = await portainer().engineInfo(conn!, epId)
      kv('Version', i.serverVersion)
      kv('Système', `${i.os ?? '—'} · noyau ${i.kernel ?? '—'}`)
      kv('Ressources', `${i.cpus ?? '—'} CPU · ${fmtBytes(i.memoryBytes)} de mémoire`)
      kv('Conteneurs', `${i.containers} (${i.running} démarrés, ${i.stopped} arrêtés, ${i.paused} en pause)`)
      kv('Images', i.images)
    })
    line()
    line('--- Disque (Docker) ---')
    await guard('Disque', async () => {
      const d = (await portainer().diskUsage(conn!, epId)).usage
      kv('Images', `${d.images.count} · ${fmtBytes(d.images.sizeBytes)} (récupérable ${fmtBytes(d.images.reclaimableBytes)})`)
      kv('Conteneurs', `${d.containers.count} · ${fmtBytes(d.containers.sizeBytes)}`)
      kv('Volumes', `${d.volumes.count} · ${fmtBytes(d.volumes.sizeBytes)} (récupérable ${fmtBytes(d.volumes.reclaimableBytes)})`)
      kv('Cache de build', `${d.buildCache.count} · ${fmtBytes(d.buildCache.sizeBytes)} (récupérable ${fmtBytes(d.buildCache.reclaimableBytes)})`)
    })
    line()
    line('--- Runner (fichiers des releases) ---')
    await guard('Runner', async () => {
      const r = await toRunnerDto(ep.id)
      kv('Statut', r.status)
      kv('Adresse', r.url)
      kv('Version / hôte', `${r.version ?? '—'} · ${r.hostname ?? '—'}`)
      kv('Racines déclarées', r.hostRoots.join(', '))
      kv('Empreinte de la clé HMAC', r.keyFingerprint)
      kv('Dernier contrôle', r.lastCheckedAt)
      kv('Dernière erreur', r.lastError)
    })
    line()
    line('--- Chemins par environnement ---')
    for (const pc of await db().select().from(schema.pathConfigs).where(eq(schema.pathConfigs.endpointId, ep.id))) {
      line(`${keyById.get(pc.environmentId) ?? pc.environmentId} : travail ${pc.workingRoot} · build ${pc.buildRoot} · tmp ${pc.tmpRoot} · données ${pc.runtimeRoot} · création auto ${pc.autoCreate ? 'oui' : 'non'} · mode ${pc.dirMode} · disque min ${pc.minFreeDiskMb} Mo · releases ${pc.releasesToKeep}`)
    }
    line()
    line('--- Règles de ports et volumes autorisés ---')
    for (const r of await db().select().from(schema.portRules).where(eq(schema.portRules.endpointId, ep.id))) line(`port ${r.portFrom}${r.portTo !== r.portFrom ? `-${r.portTo}` : ''}/${r.protocol} : ${r.policy}${r.description ? ` (${r.description})` : ''}`)
    for (const r of await db().select().from(schema.volumeRules).where(eq(schema.volumeRules.endpointId, ep.id))) line(`volume ${r.hostPath} (${r.mode})${r.enabled ? '' : ' [désactivée]'}`)
    line()
    line('--- Traefik et proxy géré ---')
    for (const tc of await db().select().from(schema.traefikConfigs).where(eq(schema.traefikConfigs.endpointId, ep.id))) {
      line(`config${tc.environmentId ? ` ${keyById.get(tc.environmentId)}` : ''} : réseau ${tc.networkName} · résolveur ${tc.certResolver ?? '—'} · domaines ${tc.allowedDomains.join(', ') || '—'} · exposition ${tc.exposure}`)
    }
    await guard('Proxy géré', async () => {
      const m = await getManagedProxy(ep.id)
      kv('Proxy géré', `${m.status}${m.pending ? ' (à appliquer)' : ''}${m.appliedAt ? ` · appliqué le ${m.appliedAt}` : ''}${m.lastError ? ` · erreur : ${m.lastError}` : ''}${m.dnsEnvNames.length ? ` · identifiants DNS : ${m.dnsEnvNames.join(', ')} (valeurs non incluses)` : ''}`)
    })
    await guard('Reverse proxies', async () => {
      const [row] = await liveEndpoints(user, ep.id)
      if (!row) return
      const topo = await endpointTopology(row)
      for (const p of topo.proxies) line(`proxy ${p.kind} ${p.container.name} (${p.container.image}) · réseaux ${p.networks.join(', ')}${p.warnings.length ? ` · alertes : ${p.warnings.join(' ; ')}` : ''}`)
      for (const r of topo.routes) line(`route ${r.hosts.join(', ') || r.rule || r.router} → ${r.container?.name ?? r.targetUrl ?? '—'}${r.targetPort ? `:${r.targetPort}` : ''} via ${r.network ?? '—'}${r.tls ? ' [TLS]' : ''}${r.warnings.length ? ` · ${r.warnings.join(' ; ')}` : ''}`)
    })
    line()
    line('--- Plan d\'adressage ---')
    await guard('Plan d\'adressage', async () => {
      const plan = await addressPlan(ep.id)
      kv('Plage', plan.pool ? `${plan.pool.base} en /${plan.pool.prefix}${plan.pool.avoid.length ? ` · à éviter ${plan.pool.avoid.join(', ')}` : ''}${plan.poolUsage ? ` · ${plan.poolUsage.used}/${plan.poolUsage.capacity}` : ''}` : 'aucune (sous-réseaux de Docker)')
      for (const n of plan.networks) line(`${n.name.padEnd(40)} ${n.subnets.join(', ').padEnd(20)} ${String(n.containers.length).padStart(3)} cont. · ${n.owner.kind}${n.owner.project ? ` ${n.owner.project}/${n.owner.environment}` : n.owner.stack ? ` ${n.owner.stack}` : ''}${n.issues.length ? ` · ${n.issues.map(i => i.message).join(' ; ')}` : ''}${n.notMovableReason && n.owner.kind !== 'system' ? ` · non déplaçable : ${n.notMovableReason}` : ''}`)
    })
    line()
    line('--- Profils Watchtower ---')
    await guard('Profils Watchtower', async () => {
      const profiles = await listProfiles(ep.id)
      if (!profiles.length) line('Aucun profil')
      for (const p of profiles) {
        line(`${p.name} (${p.scope}) : ${p.timing === 'schedule' ? `planifié ${p.schedule}` : `toutes les ${Math.round(p.intervalSec / 60)} min`} · conteneur ${p.runtime.state}${p.runtime.detail ? ` (${p.runtime.detail})` : ''} · image ${p.image ?? '—'}${p.pending ? ' · à appliquer' : ''}`)
        line(`    projets : ${p.projects.map(x => `${x.project} (${x.environment})${x.paused ? ' [pause]' : ''}`).join(', ') || 'aucun'}${p.excluded.length ? ` · exclus : ${p.excluded.join(', ')}` : ''}${p.registries.length ? ` · registres : ${p.registries.map(r => `${r.registry} (${r.username})`).join(', ')}` : ''}`)
      }
    })
    line()
    line('--- Projets ---')
    const targets = await db().select({ t: schema.projectTargets, project: schema.projects, env: schema.environments })
      .from(schema.projectTargets)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
      .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
      .where(eq(schema.projectTargets.endpointId, ep.id))
    for (const r of targets) {
      const [last] = await db().select({ action: schema.deployments.action, status: schema.deployments.status, at: schema.deployments.createdAt }).from(schema.deployments)
        .where(eq(schema.deployments.targetId, r.t.id)).orderBy(desc(schema.deployments.createdAt)).limit(1)
      const health = (r.t.healthState as { status?: string } | null)?.status
      line(`${r.project.name} (${r.env.name}) · stack ${r.t.stackName ?? '—'} · santé ${health ?? '—'} · dernier ${last ? `${last.action} ${last.status} ${last.at.toISOString()}` : '—'}${r.project.archivedAt ? ' · archivé' : ''}`)
    }
    if (!targets.length) line('Aucun projet')
    line()
    line('--- Conteneurs de l\'hôte ---')
    await guard('Conteneurs', async () => {
      for (const c of (await portainer().listContainers(conn!, epId)).sort((a, b) => (a.names[0] ?? '').localeCompare(b.names[0] ?? ''))) {
        const stack = c.labels['com.docker.compose.project']
        const owner = c.labels['platform.project'] ? `projet ${c.labels['platform.project']}/${c.labels['platform.environment'] ?? ''}` : stack ? `stack ${stack}` : 'autonome'
        line(`${(c.names[0] ?? c.id.slice(0, 12)).replace(/^\//, '').padEnd(45)} ${c.state.padEnd(9)} ${c.image} · ${owner} · ${c.status}`)
      }
    })
  }

  section('Audit récent (50 dernières actions sur le serveur)')
  const events = await db().select().from(schema.auditEvents).where(eq(schema.auditEvents.serverId, serverId)).orderBy(desc(schema.auditEvents.ts)).limit(50)
  for (const e of events) line(`${e.ts.toISOString()} ${e.outcome.padEnd(8)} ${e.action.padEnd(32)} ${e.actorLabel}${e.targetType ? ` · ${e.targetType}` : ''}`)
  line()
  line('=== Fin du rapport ===')
  // Dernière passe : motifs sensibles éventuellement présents dans des messages d'erreur ou des statuts.
  return `${redactPatterns(out.join('\n'))}\n`
}

// ---------------------------------------------------------------------------
// Rapport global de la plateforme
// ---------------------------------------------------------------------------

/** Variables d'environnement dont la valeur n'est jamais incluse (clés, mots de passe, jetons). */
const SENSITIVE_ENV = /(^MASTER_KEY$|^MASTER_KEYS_PREVIOUS$|PASSWORD$|SECRET|TOKEN|PRIVATE)/

/**
 * Rapport « tech support » de la plateforme entière : console (révision, processus), santé (base,
 * Redis, worker), base de données, files de tâches, configuration, réglages, moteur de mises à jour,
 * utilisateurs (nombres seulement), notifications, serveurs, projets, échecs récents. Ni secret
 * (clés, mots de passe, jetons masqués), ni donnée personnelle (aucune adresse e-mail d'utilisateur).
 */
export async function globalTechSupportReport(user: AuthUser): Promise<string> {
  const out: string[] = []
  const line = (s = '') => out.push(s)
  const section = (title: string) => {
    line()
    line(`=== ${title} ${'='.repeat(Math.max(3, 74 - title.length))}`)
  }
  const kv = (k: string, v: unknown) => line(`${k.padEnd(30)} ${v === null || v === undefined || v === '' ? '—' : String(v)}`)
  const guard = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn()
    }
    catch (err) {
      line(`(${label} indisponible : ${(err as Error).message.slice(0, 300)})`)
    }
  }

  line('TECH SUPPORT — Sherpa')
  kv('Généré le', new Date().toISOString())
  kv('Par', user.email)

  section('Console')
  const mem = process.memoryUsage()
  kv('Révision', process.env.APP_REVISION ?? 'dev')
  kv('Adresse (APP_URL)', process.env.APP_URL)
  kv('Node.js', process.version)
  kv('Système', `${process.platform} ${process.arch}`)
  kv('Processus', `pid ${process.pid} · en service depuis ${Math.round(process.uptime() / 60)} min · mémoire ${fmtBytes(mem.rss)} (tas ${fmtBytes(mem.heapUsed)})`)

  section('Santé')
  await guard('Base', async () => {
    const [v] = (await db().execute(sql`select version() as v, pg_size_pretty(pg_database_size(current_database())) as size`)) as unknown as { v: string, size: string }[]
    kv('Base de données', `ok · ${v?.v.split(',')[0]} · ${v?.size}`)
  })
  await guard('Redis', async () => {
    const info = await redis().info('server')
    const mem = await redis().info('memory')
    kv('Redis', `ok · ${info.match(/redis_version:(\S+)/)?.[1] ?? info.match(/valkey_version:(\S+)/)?.[1] ?? '?'} · mémoire ${mem.match(/used_memory_human:(\S+)/)?.[1] ?? '?'}`)
    const beat = await redis().get(WORKER_HEARTBEAT_KEY)
    kv('Worker', beat ? `présent (dernier signal ${beat})` : 'absent : aucun signal récent')
  })

  section('Base de données')
  await guard('Migrations', async () => {
    const rows = (await db().execute(sql`select count(*)::int as n, max(created_at) as last from drizzle.__drizzle_migrations`)) as unknown as { n: number, last: string }[]
    kv('Migrations appliquées', `${rows[0]?.n ?? 0} (dernière ${rows[0]?.last ? new Date(Number(rows[0].last)).toISOString() : '—'})`)
  })
  await guard('Volumétrie', async () => {
    const counts: [string, unknown][] = [
      ['Serveurs', schema.portainerServers], ['Endpoints', schema.serverEndpoints], ['Projets', schema.projects], ['Cibles', schema.projectTargets],
      ['Releases', schema.releases], ['Déploiements', schema.deployments], ['Lignes de journal', schema.deploymentLogs], ['Événements d\'audit', schema.auditEvents],
    ]
    for (const [label, table] of counts) kv(label, await db().$count(table as typeof schema.projects))
  })

  section('Files de tâches')
  await guard('Files', async () => {
    for (const [name, q] of [['déploiements', deploymentQueue()], ['maintenance', maintenanceQueue()], ['notifications', notificationQueue()]] as const) {
      const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')
      kv(`File ${name}`, `en attente ${c.waiting} · en cours ${c.active} · différés ${c.delayed} · échecs ${c.failed} · terminés ${c.completed}`)
      for (const j of await q.getFailed(0, 4)) line(`    échec ${j.name} ${j.finishedOn ? new Date(j.finishedOn).toISOString() : ''} : ${(j.failedReason ?? '').slice(0, 300)}`)
    }
  })

  section('Configuration (environnement)')
  const e = env() as Record<string, unknown>
  for (const k of Object.keys(e).sort(byCode)) {
    const v = e[k]
    kv(k, v === undefined ? null : SENSITIVE_ENV.test(k) && !k.endsWith('_FILE') ? '•••••• (définie)' : String(v))
  }

  section('Réglages enregistrés')
  for (const s of await db().select().from(schema.appSettings).orderBy(schema.appSettings.key)) {
    kv(s.key, JSON.stringify(redactObject(s.value)).slice(0, 600))
  }
  await guard('Moteur de mises à jour', async () => {
    const u = await getUpdateEngine()
    kv('Image Watchtower', `${u.image}${u.digest ? ' (figée)' : ''}${u.latest ? ` · dernière publiée ${u.latest}` : ''}`)
    kv('À basculer', `${u.outdated.length} cible(s), ${u.outdatedProfiles.length} profil(s)`)
  })

  section('Utilisateurs (nombres seulement)')
  for (const r of await db().select({ kind: schema.users.kind, status: schema.users.status, n: sql<number>`count(*)::int` }).from(schema.users).groupBy(schema.users.kind, schema.users.status)) {
    kv(`${r.kind} / ${r.status}`, r.n)
  }
  kv('Rôles définis', await db().$count(schema.roles))
  kv('Groupes', await db().$count(schema.userGroups))

  section('Notifications')
  for (const c of await db().select().from(schema.notificationChannels).orderBy(schema.notificationChannels.name)) line(`${c.kind.padEnd(14)} ${c.enabled ? 'actif  ' : 'inactif'} ${c.name}`)
  const failedDeliveries = await db().select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.status, 'failed')).orderBy(desc(schema.notificationDeliveries.createdAt)).limit(10)
  for (const d of failedDeliveries) line(`échec ${d.createdAt.toISOString()} ${d.kind} « ${d.channelName} » (${d.attempts} essai(s)) : ${(d.error ?? '').slice(0, 300)}`)

  section('Serveurs')
  for (const s of await db().select().from(schema.portainerServers).orderBy(schema.portainerServers.name)) {
    const eps = await db().$count(schema.serverEndpoints, eq(schema.serverEndpoints.serverId, s.id))
    line(`${s.name.padEnd(28)} ${s.transport.padEnd(6)} ${s.status.padEnd(9)} ${(s.detectedVersion ?? '—').padEnd(26)} ${eps} endpoint(s) · contrôlé ${s.lastCheckedAt?.toISOString() ?? '—'}${s.lastError ? ` · erreur : ${s.lastError.slice(0, 200)}` : ''}`)
  }

  section('Projets')
  const targets = await db().select({ t: schema.projectTargets, project: schema.projects, env: schema.environments })
    .from(schema.projectTargets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
  const byHealth = new Map<string, number>()
  for (const r of targets) {
    const h = r.project.archivedAt ? 'archivé' : !r.t.currentReleaseId ? 'jamais déployé' : (r.t.healthState as { status?: string } | null)?.status ?? 'inconnu'
    byHealth.set(h, (byHealth.get(h) ?? 0) + 1)
  }
  kv('Cibles', `${targets.length} · ${[...byHealth.entries()].map(([k, n]) => `${k} ${n}`).join(' · ')}`)
  for (const r of targets.filter(x => !x.project.archivedAt && ['degraded', 'down'].includes((x.t.healthState as { status?: string } | null)?.status ?? ''))) {
    line(`    ${(r.t.healthState as { status: string }).status} : ${r.project.name} (${r.env.name}) · ${JSON.stringify((r.t.healthState as { failing?: unknown }).failing ?? [])}`)
  }

  section('Déploiements en échec récents (20)')
  const failed = await db().select({ d: schema.deployments, project: schema.projects.name, env: schema.environments.name })
    .from(schema.deployments)
    .innerJoin(schema.projectTargets, eq(schema.projectTargets.id, schema.deployments.targetId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
    .innerJoin(schema.environments, eq(schema.environments.id, schema.projectTargets.environmentId))
    .where(inArray(schema.deployments.status, ['FAILED', 'ROLLED_BACK', 'VALIDATION_FAILED']))
    .orderBy(desc(schema.deployments.createdAt)).limit(20)
  for (const f of failed) line(`${f.d.createdAt.toISOString()} ${f.d.status.padEnd(17)} ${f.d.action.padEnd(9)} ${f.project} (${f.env}) ${f.d.id}${f.d.error ? ` — ${f.d.error.slice(0, 300)}` : ''}`)

  section('Actions en échec ou refusées (50 dernières)')
  for (const a of await db().select().from(schema.auditEvents).where(inArray(schema.auditEvents.outcome, ['failure', 'denied'])).orderBy(desc(schema.auditEvents.ts)).limit(50)) {
    line(`${a.ts.toISOString()} ${a.outcome.padEnd(8)} ${a.action.padEnd(32)} ${a.targetType ?? ''}`)
  }
  line()
  line('=== Fin du rapport ===')
  return `${redactPatterns(out.join('\n'))}\n`
}
