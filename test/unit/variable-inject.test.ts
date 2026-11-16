import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { type AnalyzeContext, analyzeCompose } from '../../server/lib/compose/analyze'

const ctx = (variables: AnalyzeContext['variables']): AnalyzeContext => ({
  projectSlug: 'netbox', projectId: 'p1', environmentKey: 'production', environmentId: 'e1', releaseSlug: 'r-0001-aaaaaa', composeDir: '',
  files: new Set(), variables, portRules: [], portApprovals: [], volumeRules: [], runtimeDir: '/srv/apps-data/production/netbox', workingRoots: [],
  networks: [], dockerVolumes: [], traefik: null, exposures: [], takenHosts: [],
})
const compose = 'services:\n  netbox:\n    image: netboxcommunity/netbox:v4.3\n    environment:\n      DB_HOST: postgres\n  worker:\n    image: netboxcommunity/netbox:v4.3\n  postgres:\n    image: postgres:16-alpine\n'

describe('variables injectées dans l\'environnement', () => {
  it('ajoutée aux services choisis sans que le Compose la cite ; secrète : jamais écrite', () => {
    const r = analyzeCompose(compose, ctx({
      CSRF_TRUSTED_ORIGINS: { value: 'https://netbox.exemple.fr', secret: false, inject: ['netbox', 'worker'] },
      SECRET_KEY: { value: 'k'.repeat(50), secret: true, inject: ['netbox'] },
    }))
    expect(r.ok).toBe(true)
    const f = YAML.parse(r.finalYaml!)
    expect(f.services.netbox.environment).toMatchObject({ DB_HOST: 'postgres', CSRF_TRUSTED_ORIGINS: 'https://netbox.exemple.fr', SECRET_KEY: '${SECRET_KEY}' })
    expect(f.services.worker.environment).toEqual({ CSRF_TRUSTED_ORIGINS: 'https://netbox.exemple.fr' })
    expect(f.services.postgres.environment).toBeUndefined()
    expect(r.finalYaml).not.toContain('k'.repeat(50))
    expect(r.issues.some(i => i.code === 'variable.unused')).toBe(false)
    expect(r.changes.map(c => c.message)).toContain('Variable CSRF_TRUSTED_ORIGINS injectée dans l\'environnement')
  })

  it('« * » : tous les services ; valeur du Compose prioritaire ; service inconnu signalé', () => {
    const r = analyzeCompose(compose, ctx({
      TZ: { value: 'Europe/Paris', secret: false, inject: ['*'] },
      DB_HOST: { value: 'autre', secret: false, inject: ['netbox'] },
      X: { value: '1', secret: false, inject: ['absent'] },
    }))
    const f = YAML.parse(r.finalYaml!)
    for (const s of ['netbox', 'worker', 'postgres']) expect(f.services[s].environment.TZ).toBe('Europe/Paris')
    expect(f.services.netbox.environment.DB_HOST).toBe('postgres')
    expect(r.issues.find(i => i.code === 'variable.inject_kept')?.service).toBe('netbox')
    expect(r.issues.find(i => i.code === 'variable.inject_unknown')?.message).toContain('absent')
  })
})
