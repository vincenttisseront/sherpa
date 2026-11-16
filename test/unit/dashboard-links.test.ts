/** Accès d'une cible au tableau de bord : expositions gérées puis URL détectées sur les proxies. */
import { describe, expect, it } from 'vitest'
import { stackNameFor } from '../../server/lib/compose/analyze'
import { linksOf } from '../../server/services/dashboard-links'

describe('accès d\'une cible', () => {
  it('expositions gérées d\'abord (port HTTPS réel), puis routes détectées de la stack, sans doublon', () => {
    const t = { exposures: [{ host: 'app.localhost', pathPrefix: null, service: 'web' }], stackName: 'shop', slug: 'shop', envKey: 'staging' }
    const links = linksOf(t, 28443, [
      { stack: 'shop', host: 'app.localhost', url: 'https://app.localhost:28443', service: 'web' },
      { stack: 'shop', host: 'admin.localhost', url: 'https://admin.localhost:8443', service: 'admin' },
      { stack: 'autre', host: 'x.localhost', url: 'https://x.localhost', service: 'x' },
      { stack: 'shop', host: '*', url: 'http://*:8081', service: 'web' },
    ])
    expect(links).toEqual([
      { host: 'app.localhost', url: 'https://app.localhost:28443/', service: 'web', detected: false },
      { host: 'admin.localhost', url: 'https://admin.localhost:8443', service: 'admin', detected: true },
    ])
  })

  it('stack sans nom enregistré : nom par défaut du projet et de l\'environnement', () => {
    const links = linksOf({ exposures: [], stackName: null, slug: 'shop', envKey: 'dev' }, 443, [{ stack: stackNameFor('shop', 'dev'), host: 'a.localhost', url: 'https://a.localhost', service: null }])
    expect(links.map(l => l.host)).toEqual(['a.localhost'])
  })
})
