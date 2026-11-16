import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { aliasPlan, aliasPlanFromYaml, applyAliasPlan, rewriteHosts, rewriteStackEnv } from '../../server/lib/compose/unique-aliases'

const aliases = { redis: 'edutis-redis', postgres: 'edutis-postgres' }

describe('alias uniques', () => {
  it('réécrit l\'hôte des URL, identifiants et port conservés', () => {
    expect(rewriteHosts('postgres://app:p@ss/w@postgres:5432/app', aliases, false)).toBe('postgres://app:p@ss/w@postgres:5432/app')
    expect(rewriteHosts('postgres://app:s3cret@postgres:5432/app', aliases, false)).toBe('postgres://app:s3cret@edutis-postgres:5432/app')
    expect(rewriteHosts('redis://:pw@redis:6379/0', aliases, false)).toBe('redis://:pw@edutis-redis:6379/0')
    expect(rewriteHosts('redis://redis', aliases, false)).toBe('redis://edutis-redis')
    expect(rewriteHosts('https://redis.example.com/x', aliases, false)).toBe('https://redis.example.com/x')
    expect(rewriteHosts('redis:6379', aliases, false)).toBe('redis:6379')
    expect(rewriteHosts('redis:6379', aliases, true)).toBe('edutis-redis:6379')
    expect(rewriteHosts('redis', aliases, true)).toBe('edutis-redis')
  })

  it('plan : seulement si un service est branché sur un réseau partagé', () => {
    expect(aliasPlan(YAML.parse('services:\n  web: {}\n  redis: {}\n'), 'edutis')).toBeNull()
  })

  it('alias sur les réseaux propres, environnement des services exposés réécrit, secrets repérés', () => {
    const doc = YAML.parse([
      'services:',
      '  web:',
      '    environment:',
      '      REDIS_HOST: redis',
      '      MODE: redis',
      '      CACHE: redis://redis:6379',
      '      DATABASE_URL: ${DATABASE_URL}',
      '      PG: postgres://u:${PG_PW}@postgres/db',
      '      DB_HOST: ${DB_HOST}',
      '    networks: [internal, platform-traefik]',
      '  redis:',
      '    networks: [internal]',
      '  postgres:',
      '    networks:',
      '      internal:',
      '        aliases: [db]',
      '  worker:',
      '    environment: [CACHE=redis://redis:6379]',
      'networks:',
      '  internal: {}',
      '  platform-traefik:',
      '    external: true',
      '    name: external',
    ].join('\n'))
    const plan = aliasPlan(doc, 'edutis')!
    expect(plan.consumers).toEqual(['web'])
    expect(plan.secretVars).toEqual({ DATABASE_URL: false, PG_PW: false, DB_HOST: true })
    const changes = applyAliasPlan(doc, plan)
    expect(doc.services.web.networks).toEqual({ 'internal': { aliases: ['edutis-web'] }, 'platform-traefik': {} })
    expect(doc.services.postgres.networks).toEqual({ internal: { aliases: ['db', 'edutis-postgres'] } })
    expect(doc.services.worker.networks).toEqual({ default: { aliases: ['edutis-worker'] } })
    expect(doc.services.web.environment).toMatchObject({ REDIS_HOST: 'edutis-redis', MODE: 'redis', CACHE: 'redis://edutis-redis:6379', PG: 'postgres://u:${PG_PW}@edutis-postgres/db' })
    // Service non exposé : environnement inchangé (aucun homonyme possible).
    expect(doc.services.worker.environment).toEqual(['CACHE=redis://redis:6379'])
    expect(changes.map(c => c.message).join('\n')).toContain('REDIS_HOST, CACHE, PG')
  })

  it('variables secrètes réécrites au déploiement, sans exposer les valeurs', () => {
    const plan = aliasPlanFromYaml('services:\n  web:\n    environment:\n      DATABASE_URL: ${DATABASE_URL}\n      DB_HOST: ${DB_HOST}\n    networks: [default, t]\n  postgres: {}\nnetworks:\n  t:\n    external: true\n', 'edutis')
    const r = rewriteStackEnv([
      { name: 'DATABASE_URL', value: 'postgres://u:secret@postgres:5432/db' },
      { name: 'DB_HOST', value: 'postgres' },
      { name: 'OTHER', value: 'postgres' },
    ], plan)
    expect(r.env).toEqual([
      { name: 'DATABASE_URL', value: 'postgres://u:secret@edutis-postgres:5432/db' },
      { name: 'DB_HOST', value: 'edutis-postgres' },
      { name: 'OTHER', value: 'postgres' },
    ])
    expect(r.rewritten).toEqual(['DATABASE_URL', 'DB_HOST'])
  })
})
