/**
 * Générateurs de Compose : projets dont le Compose est produit à l'installation
 * (Harbor : étape « prepare »). Le générateur s'exécute sur l'hôte cible, dans
 * un conteneur ponctuel sans réseau ni privilège, avec pour seuls montages des
 * dossiers du projet. Le Compose obtenu suit ensuite le circuit habituel
 * (archive, analyse, déploiement). Les mots de passe sont des variables
 * secrètes de la cible : réutilisés d'une génération à l'autre (une base déjà
 * initialisée garde son mot de passe), jamais écrits sur le disque de l'hôte
 * hors des fichiers de configuration produits par prepare.
 */
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { and, eq } from 'drizzle-orm'
import { createError } from 'h3'
import { normalizeHost } from '../../shared/utils/domains'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { adaptHarborCompose, detectHarborInstaller, harborPasswordProblem, renderHarborConfig, patchHarborNginx } from '../lib/generators/harbor'
import { readZipEntry } from '../lib/zip'
import { makeZip } from '../lib/zip-writer'
import { projectLayout } from '../utils/path-guard'
import { type Progress, noProgress } from '../utils/progress'
import { redactPatterns } from '../utils/redact'
import { importEnvFiles } from './env-import'
import { type TargetRow, setTargetVariables, targetVariables } from './projects'
import { connectionFor } from './servers'
import { type StoredUpload, getUpload, storeUpload } from './uploads'

export const HARBOR_ADMIN_VAR = 'HARBOR_ADMIN_PASSWORD'
export const HARBOR_DB_VAR = 'HARBOR_DB_PASSWORD'

export interface HarborGenerateInput {
  uploadId: string
  hostname: string
  /** Absent : mot de passe déjà enregistré pour la cible. */
  adminPassword?: string | null
  withTrivy: boolean
}

export interface HarborGenerateResult {
  upload: StoredUpload
  version: string
  hostname: string
  imported: number
  changes: string[]
  logs: string[]
}

const fail = (statusCode: number, message: string, field?: string) => createError({ statusCode, statusMessage: message, ...(field ? { data: { errors: { [field]: message } } } : {}) })
const randomSecret = () => randomBytes(24).toString('base64url').replace(/[-_]/g, '').slice(0, 24) + 'Aa1'

/** Dossiers Harbor dans le dossier de données du projet. */
export function harborDirs(runtimeDir: string) {
  return { dataVolume: `${runtimeDir}/harbor/data`, prepareDir: `${runtimeDir}/harbor/prepare`, logLocation: `${runtimeDir}/harbor/log` }
}

export async function generateHarborCompose(t: TargetRow, input: HarborGenerateInput, userId: string | null, progress: Progress = noProgress): Promise<HarborGenerateResult> {
  const upload = await getUpload(input.uploadId)
  if (!upload || upload.consumedAt) throw fail(404, 'Archive introuvable ou déjà utilisée')
  const report = upload.report as { entries?: string[], rootFolder: string | null }
  const entries = report.entries ?? []
  const root = report.rootFolder
  const prepareScript = await readZipEntry(upload.storagePath, root ? `${root}/prepare` : 'prepare', 64 * 1024).catch(() => '')
  const installer = detectHarborInstaller(entries, root, prepareScript)
  if (!installer) throw fail(422, 'Cette archive n\'est pas un installateur Harbor (prepare et harbor.yml.tmpl attendus, image goharbor/prepare:vX.Y.Z)')

  const hostname = normalizeHost(input.hostname)
  const [paths] = await db().select().from(schema.pathConfigs).where(and(eq(schema.pathConfigs.endpointId, t.endpoint.id), eq(schema.pathConfigs.environmentId, t.env.id)))
  if (!paths) throw fail(422, 'Chemins de travail non configurés pour cet endpoint et cet environnement')
  const { runtimeDir } = projectLayout(paths, t.project.slug, t.target.projectPath)
  const dirs = harborDirs(runtimeDir)

  // Mots de passe : saisis, sinon ceux déjà enregistrés ; la base garde le sien d'une version à l'autre.
  const vars = await targetVariables(t.target)
  const adminPassword = input.adminPassword || vars[HARBOR_ADMIN_VAR]?.value || null
  if (!adminPassword) throw fail(422, 'Mot de passe administrateur requis pour la première installation', 'adminPassword')
  const pwdProblem = harborPasswordProblem(adminPassword)
  if (pwdProblem) throw fail(422, `Mot de passe administrateur : ${pwdProblem}`, 'adminPassword')
  const dbPassword = vars[HARBOR_DB_VAR]?.value || randomSecret()

  let harborYml: string
  try {
    harborYml = renderHarborConfig(await readZipEntry(upload.storagePath, installer.templatePath, 256 * 1024), {
      hostname, externalUrl: `https://${hostname}`, adminPassword, dbPassword, dataVolume: dirs.dataVolume, logLocation: dirs.logLocation,
    })
  }
  catch (err) {
    throw fail(422, (err as Error).message, 'hostname')
  }

  await progress.step(`Étape prepare de Harbor ${installer.version} sur ${t.endpoint.name} (image ${installer.prepareImage})`, 1, 3)
  const [server] = await db().select().from(schema.portainerServers).where(eq(schema.portainerServers.id, t.server.id))
  if (!server) throw fail(404, 'Serveur introuvable')
  const conn = await connectionFor(server)
  const run = await portainer().runOneShot(conn, t.endpoint.portainerEndpointId, {
    image: installer.prepareImage,
    cmd: ['prepare', ...(input.withTrivy ? ['--with-trivy'] : [])],
    binds: [`${dirs.dataVolume}:/data`, `${dirs.prepareDir}:/compose_location`, `${dirs.prepareDir}/common/config:/config`],
    files: [{ path: '/input/harbor.yml', content: harborYml, mode: 0o600 }],
    outputs: ['/compose_location/docker-compose.yml', '/config'],
    outputLimits: { maxBytes: 4 * 1024 * 1024, maxFiles: 500 },
    labels: { 'platform.generator': 'harbor-prepare', 'platform.project': t.project.slug, 'platform.environment': t.env.key },
    timeoutMs: 10 * 60_000,
  }).catch((err) => { throw fail(502, `Exécution de prepare impossible : ${redactPatterns((err as Error).message).slice(0, 300)}`) })
  const logs = run.logs.map(l => redactPatterns(l)).slice(-40)
  if (run.exitCode !== 0) throw createError({ statusCode: 422, statusMessage: `prepare a échoué (code ${run.exitCode}) : ${logs.slice(-3).join(' | ').slice(0, 400)}`, data: { logs } })
  const compose = run.outputs['/compose_location/docker-compose.yml']?.[0]?.content
  if (!compose) throw fail(502, 'prepare n\'a pas produit de docker-compose.yml')

  await progress.step('Adaptation du Compose et enregistrement', 2, 3)
  const adapted = adaptHarborCompose(compose, dirs.prepareDir)
  // nginx du proxy : résolution continue des services (sinon adresse périmée après une recréation isolée).
  const nginxConf = run.outputs['/config']?.find(f => f.path === '/config/nginx/nginx.conf')?.content
  if (nginxConf) {
    const patched = patchHarborNginx(nginxConf)
    if (patched.changed) {
      const cp = await portainer().runOneShot(conn, t.endpoint.portainerEndpointId, {
        image: installer.prepareImage,
        entrypoint: ['cp'],
        cmd: ['/input/nginx.conf', '/config/nginx/nginx.conf'],
        binds: [`${dirs.prepareDir}/common/config:/config`],
        files: [{ path: '/input/nginx.conf', content: patched.conf, mode: 0o644 }],
        outputs: [],
        outputLimits: { maxBytes: 0, maxFiles: 0 },
        labels: { 'platform.generator': 'harbor-prepare', 'platform.project': t.project.slug, 'platform.environment': t.env.key },
        timeoutMs: 60_000,
      }).catch((err) => { throw fail(502, `Adaptation de nginx impossible : ${redactPatterns((err as Error).message).slice(0, 300)}`) })
      if (cp.exitCode !== 0) throw fail(502, `Adaptation de nginx impossible (code ${cp.exitCode})`)
      adapted.changes.push('proxy (nginx) : adresses de core et portal relues en continu (DNS de Docker)')
    }
  }
  // Fichiers d'environnement référencés par le Compose (common/config/<composant>/env), lus dans /config.
  const configFiles = new Map((run.outputs['/config'] ?? []).map(f => [f.path.replace(/^\/config\//, 'common/config/'), f.content]))
  const envEntries = adapted.envFiles.map((p) => {
    const content = configFiles.get(p)
    if (content === undefined) throw fail(502, `Fichier ${p} absent de la sortie de prepare`)
    return { name: p, data: content }
  })
  const meta = { generator: 'harbor-prepare', version: installer.version, hostname, externalUrl: `https://${hostname}`, withTrivy: input.withTrivy, dataVolume: dirs.dataVolume, configDir: dirs.prepareDir, generatedAt: new Date().toISOString() }
  const zip = makeZip([
    { name: 'docker-compose.yml', data: `# Généré par goharbor/prepare ${installer.version} puis adapté par la plateforme : ne pas modifier à la main.\n${adapted.yaml}` },
    ...envEntries,
    { name: 'harbor-generation.json', data: `${JSON.stringify(meta, null, 2)}\n` },
  ])
  const stored = await storeUpload(Readable.from(zip), `harbor-${installer.version}-compose.zip`, userId, progress)

  // Secrets de la cible : mots de passe conservés, valeurs des env_file importées (sans régénération : elles viennent d'être générées).
  const current = await targetVariables(t.target)
  await setTargetVariables(t.target.id, [
    ...Object.entries(current).filter(([n]) => n !== HARBOR_ADMIN_VAR && n !== HARBOR_DB_VAR).map(([name, v]) => ({ name, secret: v.secret })),
    { name: HARBOR_ADMIN_VAR, value: adminPassword, secret: true },
    { name: HARBOR_DB_VAR, value: dbPassword, secret: true },
  ])
  const [fresh] = await db().select().from(schema.projectTargets).where(eq(schema.projectTargets.id, t.target.id))
  const imported = await importEnvFiles({ ...t, target: fresh! }, { source: 'upload', uploadId: stored.id, composePath: 'docker-compose.yml', overwrite: true, regenerateSecrets: false })

  // Exposition du proxy de Harbor par Traefik.
  const exposures = [...fresh!.exposures.filter(e => !(e.service === 'proxy' || normalizeHost(e.host) === hostname)), { service: 'proxy', host: hostname, port: 8080, pathPrefix: null, middlewares: [] }]
  await db().update(schema.projectTargets).set({ exposures }).where(eq(schema.projectTargets.id, t.target.id))

  return { upload: stored, version: installer.version, hostname, imported: imported.imported.length, changes: adapted.changes, logs }
}
