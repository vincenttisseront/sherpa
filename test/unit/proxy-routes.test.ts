import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { managedTraefikArgs, managedTraefikCompose, routesDynamicConfig } from '../../server/lib/proxy/managed'
import { containerForRoute } from '../../server/services/proxy-routes'
import { managedProxyConfig } from '../../shared/schemas/managed-proxy'

const route = { id: '0b1c2d3e-aaaa-bbbb-cccc-1234567890ab', containerName: 'console-app-1', host: 'console.localhost', pathPrefix: null, port: 3000, https: true }
const cfg = managedProxyConfig.parse({ networks: ['platform-edge'] })

describe('routes du Traefik géré vers des conteneurs hors plateforme', () => {
  it('routeur HTTPS (ou HTTP) et service vers le conteneur, joint par son nom', () => {
    const doc = YAML.parse(routesDynamicConfig([route, { ...route, id: '1b1c2d3e-aaaa-bbbb-cccc-1234567890ab', host: 'api.localhost', pathPrefix: '/v1', https: false }]))
    const [a, b] = Object.values(doc.http.routers) as { rule: string, entryPoints: string[], tls?: object }[]
    expect(a).toMatchObject({ rule: 'Host(`console.localhost`)', entryPoints: ['websecure'], tls: {} })
    expect(b).toMatchObject({ rule: 'Host(`api.localhost`) && PathPrefix(`/v1`)', entryPoints: ['web'] })
    expect(b!.tls).toBeUndefined()
    expect(Object.values(doc.http.services)[0]).toEqual({ loadBalancer: { servers: [{ url: 'http://console-app-1:3000' }] } })
  })
  it('fournisseur fichier sur le répertoire dynamique, routes en « config » du Compose', () => {
    expect(managedTraefikArgs(cfg)).not.toContain('--providers.file.directory=/etc/traefik/dynamic')
    expect(managedTraefikArgs(cfg, [], [route])).toContain('--providers.file.directory=/etc/traefik/dynamic')
    const compose = YAML.parse(managedTraefikCompose(cfg, [], [], [route]).split('\n').slice(1).join('\n'))
    expect(compose.services.traefik.configs).toEqual([{ source: 'platform_routes', target: '/etc/traefik/dynamic/routes.yml' }])
    expect(compose.configs.platform_routes.content).toContain('console.localhost')
  })
  it('conteneur retrouvé par projet et service Compose après recréation, sinon par nom', () => {
    const c = (id: string, name: string, labels: Record<string, string>, state = 'running') => ({ id, names: [name], image: 'x', state, status: '', labels, networks: [], createdAt: '' })
    const containers = [c('a', 'old-name', { 'com.docker.compose.project': 'console', 'com.docker.compose.service': 'app' }, 'exited'), c('b', 'console-app-1', { 'com.docker.compose.project': 'console', 'com.docker.compose.service': 'app' }), c('z', 'solo', {})]
    expect(containerForRoute({ stack: 'console', service: 'app', containerName: 'x' }, containers)?.id).toBe('b')
    expect(containerForRoute({ stack: null, service: null, containerName: 'solo' }, containers)?.id).toBe('z')
    expect(containerForRoute({ stack: 'autre', service: 'app', containerName: 'absent' }, containers)).toBeNull()
  })
})
