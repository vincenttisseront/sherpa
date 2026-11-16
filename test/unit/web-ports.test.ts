import { describe, expect, it } from 'vitest'
import { containerPortOf, suggestWebHost, webHint } from '../../shared/utils/web-ports'

const port = (entry: string, o: { service?: string, protocol?: 'tcp' | 'udp', containerPort?: number } = {}) => ({ service: o.service ?? 'app', entry, protocol: o.protocol ?? 'tcp', containerPort: o.containerPort })

describe('webHint', () => {
  it('port du conteneur courant d\'une application web', () => {
    expect(webHint(port('8089:80'), 'traefik/whoami:v1.10')).toBe('port 80 du conteneur')
    expect(webHint(port('127.0.0.1:4080:3000/tcp'), 'node:22')).toBe('port 3000 du conteneur')
    expect(containerPortOf(port('127.0.0.1:4080:3000/tcp'))).toBe(3000)
  })
  it('port quelconque d\'une image web', () => {
    expect(webHint(port('9443:9443', { service: 'portal' }), 'acme/portal:1')).toBe('image acme/portal:1')
  })
  it('pas web : bases de données, SSH, UDP, HTTPS déjà chiffré', () => {
    expect(webHint(port('5432:5432', { service: 'db' }), 'postgres:16')).toBeNull()
    expect(webHint(port('2222:22', { service: 'git' }), 'gitea/gitea:1')).toBeNull()
    expect(webHint(port('8080:80', { protocol: 'udp' }), 'nginx:1')).toBeNull()
    expect(webHint(port('8443:443'), 'nginx:1')).toBeNull()
  })
  it('port du conteneur fourni par l\'analyse prioritaire sur l\'entrée', () => {
    expect(webHint(port('8000-8001:9000-9001', { containerPort: 9001 }), 'php:8')).toBe('image php:8')
  })
})

describe('suggestWebHost', () => {
  it('domaine générique autorisé, sinon premier domaine, sinon localhost', () => {
    expect(suggestWebHost('web', 'shop-staging', ['*.exemple.fr'])).toBe('web-shop-staging.exemple.fr')
    expect(suggestWebHost('web', 'shop-staging', ['app.exemple.fr'])).toBe('app.exemple.fr')
    expect(suggestWebHost('Web_UI', 'shop', [])).toBe('web-ui-shop.localhost')
  })
})
