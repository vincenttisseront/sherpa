/** Redéploiement : un échec de pull ne bloque que pour une image absente de l'hôte. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[][] = []
let failing = new Set<string>()
vi.mock('../../server/adapters/portainer/compose', () => ({
  runCompose: vi.fn(async (_conn: unknown, o: { args: string[] }) => {
    calls.push(o.args)
    const services = o.args.slice(o.args.indexOf('pull') + 1)
    if (o.args.includes('pull') && services.some(s => failing.has(s))) throw new Error('docker compose a échoué : Error pull access denied for edutis-web, repository does not exist')
    return []
  }),
}))

const compose = 'services:\n  web:\n    image: edutis-web:baaf7b7\n  db:\n    image: postgres:16-alpine\n  app:\n    image: platform/edutis-app:r-0001\n  job:\n    image: tool:local\n    pull_policy: never\n'
const present = new Set(['edutis-web:baaf7b7', 'postgres:16-alpine'])
const base = { imageInfo: vi.fn(async (_c: unknown, _e: number, image: string) => (present.has(image) ? { id: 'x', created: null, repoDigests: [] } : null)) }

describe('mise à jour d\'une stack : pull des images', () => {
  beforeEach(() => {
    calls.length = 0
    failing = new Set()
  })

  it('jamais les builds de la plateforme ni pull_policy never', async () => {
    const { composeStackOps } = await import('../../server/adapters/portainer/stacks')
    await composeStackOps(base as never, 60_000).updateStack({} as never, 1, { endpointId: 1, name: 'edutis', composeContent: compose, env: [], pullImage: true })
    expect(calls).toEqual([['-p', 'edutis', '-f', '-', 'pull', 'web', 'db'], ['-p', 'edutis', '-f', '-', 'up', '-d', '--remove-orphans']])
  })

  it('image présente sur l\'hôte introuvable au registre : conservée, avertissement, les autres récupérées', async () => {
    failing = new Set(['web'])
    const warnings: string[] = []
    const { composeStackOps } = await import('../../server/adapters/portainer/stacks')
    await composeStackOps(base as never, 60_000).updateStack({} as never, 1, { endpointId: 1, name: 'edutis', composeContent: compose, env: [], pullImage: true, onWarning: (m) => { warnings.push(m) } })
    expect(calls.map(c => c.slice(4).join(' '))).toEqual(['pull web db', 'pull web', 'pull db', 'up -d --remove-orphans'])
    expect(warnings[0]).toMatch(/version présente sur l'hôte conservée : web \(edutis-web:baaf7b7 : pull access denied/)
  })

  it('image absente de l\'hôte et du registre : échec', async () => {
    present.delete('edutis-web:baaf7b7')
    failing = new Set(['web'])
    const { composeStackOps } = await import('../../server/adapters/portainer/stacks')
    await expect(composeStackOps(base as never, 60_000).updateStack({} as never, 1, { endpointId: 1, name: 'edutis', composeContent: compose, env: [], pullImage: true })).rejects.toThrow(/pull access denied/)
    present.add('edutis-web:baaf7b7')
  })
})
