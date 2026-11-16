import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { type AnalyzeContext, analyzeCompose } from '../../server/lib/compose/analyze'
import { graceSec, parseDurationSec, shortGraceDependencies } from '../../server/lib/compose/healthchecks'

const ctx = (over: Partial<AnalyzeContext> = {}): AnalyzeContext => ({
  projectSlug: 'netbox', projectId: 'p1', environmentKey: 'staging', environmentId: 'e1', releaseSlug: 'r-0001-abcdef',
  composeDir: '', files: new Set(['compose.yml']), variables: {}, portRules: [], portApprovals: [], volumeRules: [],
  runtimeDir: '/srv/apps-data/staging/netbox', workingRoots: ['/srv/deployments/staging'], networks: [], dockerVolumes: [],
  ...over,
})

// Forme du Compose de netbox-docker : le worker attend que netbox soit sain.
const NETBOX = `
services:
  netbox:
    image: netboxcommunity/netbox:latest
    healthcheck:
      test: /opt/netbox/health.sh
      start_period: 90s
      timeout: 3s
      interval: 15s
  netbox-worker:
    image: netboxcommunity/netbox:latest
    depends_on:
      netbox:
        condition: service_healthy
`

describe('healthchecks', () => {
  it('lit les durées Compose', () => {
    expect(parseDurationSec('1m30s')).toBe(90)
    expect(parseDurationSec('300ms')).toBeCloseTo(0.3)
    expect(parseDurationSec('abc')).toBeNull()
    expect(graceSec({ start_period: '90s', interval: '15s' })).toBe(135)
  })

  it('signale un service attendu « sain » au délai de grâce court', () => {
    const r = analyzeCompose(NETBOX, ctx())
    const i = r.issues.find(x => x.code === 'healthcheck.short_grace')
    expect(i?.service).toBe('netbox')
    expect(i?.message).toContain('135 s')
    expect(shortGraceDependencies({ a: { healthcheck: { test: 'x', start_period: '5m' } }, b: { depends_on: { a: { condition: 'service_healthy' } } } })).toEqual([])
  })

  it('applique les réglages de la cible au Compose final', () => {
    const r = analyzeCompose(NETBOX, ctx({ healthchecks: { 'netbox': { startPeriodSec: 300, retries: 5 }, 'absent': { retries: 2 }, 'netbox-worker': { retries: 2 } } }))
    expect(r.ok).toBe(true)
    const hc = (YAML.parse(r.finalYaml!) as { services: Record<string, { healthcheck?: Record<string, unknown> }> }).services.netbox!.healthcheck!
    expect(hc).toMatchObject({ start_period: '300s', retries: 5, interval: '15s' })
    expect(r.changes.some(c => c.kind === 'healthcheck' && c.service === 'netbox')).toBe(true)
    expect(r.issues.some(x => x.code === 'healthcheck.short_grace')).toBe(false)
    expect(r.issues.filter(x => x.code.startsWith('healthcheck.override')).map(x => x.service).sort()).toEqual(['absent', 'netbox-worker'])
  })
})
