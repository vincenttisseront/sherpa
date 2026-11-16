import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { BUILTIN_TEMPLATES } from '../../shared/data/compose-templates'
import { type AnalyzeContext, analyzeCompose } from '../../server/lib/compose/analyze'
import { findVariables } from '../../server/lib/compose/interpolate'
import { deriveVariables, validateTemplateCompose } from '../../server/services/templates'

const ctx = (variables: AnalyzeContext['variables']): AnalyzeContext => ({
  projectSlug: 'modele', projectId: 'p1', environmentKey: 'staging', environmentId: 'e-stg', releaseSlug: 'r-0001-abcdef', composeDir: '', files: new Set(['compose.yml']),
  variables, portRules: [], portApprovals: [], volumeRules: [], runtimeDir: '/srv/apps-data/staging/modele', workingRoots: ['/srv/deployments/staging'],
  networks: [], dockerVolumes: [],
})

describe('modèles fournis', () => {
  it('ont des clés et noms uniques', () => {
    expect(new Set(BUILTIN_TEMPLATES.map(t => t.key)).size).toBe(BUILTIN_TEMPLATES.length)
    expect(new Set(BUILTIN_TEMPLATES.map(t => t.name)).size).toBe(BUILTIN_TEMPLATES.length)
  })

  it.each(BUILTIN_TEMPLATES.map(t => [t.key, t] as const))('%s : YAML valide, variables déclarées = variables utilisées, sans port publié', (_key, t) => {
    expect(validateTemplateCompose(t.compose)).toBeNull()
    const used = findVariables(t.compose).map(v => v.name).sort()
    expect(t.variables.map(v => v.name).sort()).toEqual(used)
    const services = (YAML.parse(t.compose) as { services: Record<string, { ports?: unknown, container_name?: unknown }> }).services
    for (const s of Object.values(services)) {
      expect(s.ports).toBeUndefined()
      expect(s.container_name).toBeUndefined()
    }
    // Les secrets ne sont jamais en clair dans le Compose : seules des références.
    for (const v of t.variables.filter(x => x.secret)) expect(t.compose).toContain(`\${${v.name}}`)
  })

  it.each(BUILTIN_TEMPLATES.map(t => [t.key, t] as const))('%s : passe l\'analyse de sécurité sans erreur', (_key, t) => {
    const vars = Object.fromEntries(t.variables.map(v => [v.name, { value: v.default ?? 'valeur-de-test', secret: !!v.secret }]))
    const r = analyzeCompose(t.compose, ctx(vars as never))
    expect(r.issues.filter(i => i.severity === 'error'), JSON.stringify(r.issues.filter(i => i.severity === 'error'))).toEqual([])
  })
})

describe('modèles personnalisés', () => {
  it('déduit les variables et marque les secrets', () => {
    const v = deriveVariables('services:\n  a:\n    image: x:1\n    environment:\n      DB_PASSWORD: ${DB_PASSWORD}\n      MODE: ${MODE:-prod}\n')
    expect(v).toEqual([
      { name: 'DB_PASSWORD', label: 'DB_PASSWORD', secret: true, generate: 'password' },
      { name: 'MODE', label: 'MODE' },
    ])
  })

  it.each([
    ['services: [', 'YAML invalide'],
    ['version: "3"\nnetworks: {}\n', 'Aucun service'],
    ['services: {}\n', 'Aucun service'],
  ])('refuse %j', (compose, message) => {
    expect(validateTemplateCompose(compose)).toContain(message)
  })
})
