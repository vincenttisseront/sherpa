/**
 * Déploiement de démonstration par le parcours réel (projet → cible → archive
 * → analyse → mise en file). Développement uniquement :
 *   npm run dev:demo-deploy -- [archive.zip] [chemin/du/compose.yml]
 */
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { and, eq } from 'drizzle-orm'
import { closeDb, db, schema } from '../server/db/client'
import { stackNameFor } from '../server/lib/compose/analyze'
import { makeZip } from '../server/lib/zip-writer'
import { closeRedis } from '../server/queue/redis'
import { createDeployment } from '../server/services/deploy-requests'
import { getTargetOr404 } from '../server/services/projects'
import { storeUpload } from '../server/services/uploads'

if (process.env.NODE_ENV === 'production') throw new Error('Script réservé au développement')
const [zipPath, composeArg] = process.argv.slice(2)

const [pick] = await db().select({ ep: schema.serverEndpoints, env: schema.environments })
  .from(schema.pathConfigs)
  .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.pathConfigs.endpointId))
  .innerJoin(schema.environments, eq(schema.environments.id, schema.pathConfigs.environmentId))
  .where(eq(schema.serverEndpoints.enabled, true))
if (!pick) throw new Error('Aucun endpoint activé avec des chemins configurés')

const body = zipPath
  ? createReadStream(zipPath)
  : Readable.from([makeZip([
      { name: 'demo/compose.yml', data: 'services:\n  web:\n    image: caddy:2.10-alpine\n    command: ["caddy", "file-server", "--listen", ":8080", "--root", "/usr/share/caddy"]\n' },
    ])])
const upload = await storeUpload(body, zipPath ?? 'demo.zip', null)
const composePath = composeArg ?? upload.report.composeFiles[0]
if (!composePath) throw new Error('Aucun fichier Compose dans l\'archive')

const [project] = await db().insert(schema.projects).values({ slug: 'demo-app', name: 'Application de démonstration' })
  .onConflictDoUpdate({ target: schema.projects.slug, set: { name: 'Application de démonstration' } }).returning()
let [target] = await db().select().from(schema.projectTargets).where(and(eq(schema.projectTargets.projectId, project!.id), eq(schema.projectTargets.environmentId, pick.env.id)))
target ??= (await db().insert(schema.projectTargets).values({ projectId: project!.id, endpointId: pick.ep.id, environmentId: pick.env.id, stackName: stackNameFor('demo-app', pick.env.key) }).returning())[0]!

try {
  const r = await createDeployment(await getTargetOr404(target.id), { uploadId: upload.id, composePath, portApprovals: [], idempotencyKey: crypto.randomUUID(), userId: null })
  console.info(`Déploiement en file sur ${pick.ep.name} / ${pick.env.key} → /deployments/${r.deploymentId}`)
}
catch (err) {
  const data = (err as { data?: { analysis?: { issues: { severity: string, message: string }[] } } }).data
  console.error(`Refusé : ${(err as Error).message}`)
  for (const i of data?.analysis?.issues ?? []) console.error(`  [${i.severity}] ${i.message}`)
}
await closeRedis()
await closeDb()
