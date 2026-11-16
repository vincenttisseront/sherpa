import { describe, expect, it } from 'vitest'
import { createMockPortainerAdapter } from '../../server/adapters/portainer/mock'
import type { PortainerError} from '../../server/adapters/portainer/types';
import { discoverEndpoint, isSupportedVersion } from '../../server/adapters/portainer/types'
import { createMockRunner } from '../../server/adapters/runner/mock'
import { validateRunnerInput } from '../../server/adapters/runner/types'

const conn = { url: 'https://portainer.test', token: 'ptr_valid_token', tlsVerify: true }

describe('adaptateur Portainer (mock)', () => {
  const p = createMockPortainerAdapter()

  it('détecte la version et les endpoints', async () => {
    expect(await p.getVersion(conn)).toEqual({ version: '2.27.4', supported: true })
    const endpoints = await p.listEndpoints(conn)
    expect(endpoints.map(e => e.kind)).toContain('docker_standalone')
  })

  it('remonte une erreur d\'authentification typée', async () => {
    await expect(p.getVersion({ ...conn, token: 'ptr_invalid' })).rejects.toMatchObject({ kind: 'auth' } satisfies Partial<PortainerError>)
  })

  it('effectue une découverte complète d\'un endpoint', async () => {
    const [ep] = await p.listEndpoints(conn)
    const d = await discoverEndpoint(p, conn, ep!)
    expect(d.networks.some(n => n.name === 'traefik-public')).toBe(true)
    expect(d.volumes.length).toBeGreaterThan(0)
  })

  it('n\'accepte que Portainer 2.x', () => {
    expect(isSupportedVersion('2.19.4')).toBe(true)
    expect(isSupportedVersion('1.24.2')).toBe(false)
    expect(isSupportedVersion('20.1')).toBe(false)
  })
})

describe('Target Runner (contrat + mock)', () => {
  const runner = createMockRunner()
  const ctx = { requestId: 'r1', actor: 'test' }

  it('refuse les chemins système', async () => {
    await expect(runner.ensureDir(ctx, { path: '/etc/cron.d', mode: '0750' })).rejects.toThrow(/système/)
  })

  it('refuse une archive avec liens symboliques autorisés', () => {
    expect(() => validateRunnerInput('extractArchive', {
      archivePath: '/srv/tmp/a.zip', destination: '/srv/deployments/dev/app/releases/r1/source',
      format: 'zip', maxFiles: 1000, maxTotalBytes: 1e8, timeoutSec: 60, allowSymlinks: true,
    })).toThrow()
  })

  it('refuse un tag d\'image contenant une injection', () => {
    expect(() => validateRunnerInput('build', {
      contextDir: '/srv/builds/dev/app', dockerfile: 'Dockerfile', imageTag: 'app:1; rm -rf /',
      buildArgs: {}, timeoutSec: 600, maxLogBytes: 1e6,
    })).toThrow()
  })

  it('vérifie l\'empreinte des fichiers déposés', async () => {
    const data = Buffer.from('hello')
    async function* stream() { yield data }
    await expect(runner.uploadFile(ctx, { path: '/srv/tmp/dev/app/a.txt', sizeBytes: 5, sha256: 'a'.repeat(64) }, stream())).rejects.toThrow(/SHA-256/)
  })
})
