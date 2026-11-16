/** Mise à niveau des images : origine dans le Compose, surcharge à l'analyse, Compose source mis à niveau. */
import { describe, expect, it } from 'vitest'
import { applyImageOverrides, imageOrigins, patchComposeImages } from '../../server/lib/compose/image-upgrade'

const NETBOX = `services:
  netbox: &netbox
    image: docker.io/netboxcommunity/netbox:\${VERSION-v4.7-5.1.1}
    user: unit:root
  netbox-worker:
    <<: *netbox
    command: [rqworker]
  postgres:
    image: docker.io/postgres:18-alpine # base
  web:
    build: ./web
  cache:
    image: "valkey/valkey:9.1-alpine"
  app:
    image: \${APP_IMAGE}
`

describe('origine des images', () => {
  it('littérale, variable avec défaut, ancre, build, variable sans défaut', () => {
    const o = imageOrigins(NETBOX)
    expect(o.netbox).toMatchObject({ raw: 'docker.io/netboxcommunity/netbox:${VERSION-v4.7-5.1.1}', variable: { name: 'VERSION', fallback: 'v4.7-5.1.1' }, inherited: false })
    expect(o['netbox-worker']).toMatchObject({ variable: { name: 'VERSION' }, inherited: true })
    expect(o.postgres).toMatchObject({ raw: 'docker.io/postgres:18-alpine', variable: null })
    expect(o.web).toMatchObject({ raw: null, build: true })
    expect(o.app!.variable).toEqual({ name: 'APP_IMAGE', fallback: null })
  })
})

describe('Compose source mis à niveau', () => {
  it('défaut de variable (ancre : une seule réécriture pour les deux services), littéral et guillemets', () => {
    const r = patchComposeImages(NETBOX, [
      { service: 'netbox', from: 'docker.io/netboxcommunity/netbox:v4.7-5.1.1', to: 'docker.io/netboxcommunity/netbox:v4.8-5.2.0' },
      { service: 'netbox-worker', from: 'docker.io/netboxcommunity/netbox:v4.7-5.1.1', to: 'docker.io/netboxcommunity/netbox:v4.8-5.2.0' },
      { service: 'postgres', from: 'postgres:18-alpine', to: 'postgres:19-alpine' },
      { service: 'cache', from: 'docker.io/valkey/valkey:9.1-alpine', to: 'valkey/valkey:9.2-alpine' },
    ])
    expect(r.changed).toEqual(['netbox', 'netbox-worker', 'postgres', 'cache'])
    expect(r.composeText).toContain('netbox:${VERSION-v4.8-5.2.0}')
    expect(r.composeText).toContain('image: docker.io/postgres:19-alpine # base')
    expect(r.composeText).toContain('image: "valkey/valkey:9.2-alpine"')
    expect(r.manual).toEqual([])
  })

  it('build et variable sans défaut : à faire à la main, expliqué', () => {
    const r = patchComposeImages(NETBOX, [
      { service: 'web', from: 'platform/x-web:r1', to: 'x' },
      { service: 'app', from: 'acme/app:1.0', to: 'acme/app:1.1' },
    ])
    expect(r.changed).toEqual([])
    expect(r.manual.map(m => m.service)).toEqual(['web', 'app'])
    expect(r.manual[1]!.reason).toContain('APP_IMAGE')
  })
})

describe('surcharge appliquée à l\'analyse', () => {
  const ov = { image: 'docker.io/netboxcommunity/netbox:v4.8-5.2.0', from: 'docker.io/netboxcommunity/netbox:v4.7-5.1.1', at: '', by: null }
  it('appliquée si le Compose déclare toujours l\'image d\'origine (écritures équivalentes)', () => {
    const services = { netbox: { image: 'netboxcommunity/netbox:v4.7-5.1.1' } as Record<string, unknown> }
    const issues = applyImageOverrides(services, { netbox: ov })
    expect(services.netbox.image).toBe(ov.image)
    expect(issues[0]).toMatchObject({ severity: 'info', code: 'image.upgrade' })
  })
  it('ignorée si une nouvelle source a changé la version', () => {
    const services = { netbox: { image: 'netboxcommunity/netbox:v4.9-5.3.0' } as Record<string, unknown> }
    const issues = applyImageOverrides(services, { netbox: ov })
    expect(services.netbox.image).toBe('netboxcommunity/netbox:v4.9-5.3.0')
    expect(issues[0]).toMatchObject({ severity: 'warning', code: 'image.upgrade_stale' })
  })
})
