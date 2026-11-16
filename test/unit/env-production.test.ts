import { afterEach, describe, expect, it } from 'vitest'
import { env, resetEnvCache } from '../../server/utils/env'

describe('configuration en production', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, DATABASE_URL: process.env.DATABASE_URL }
  afterEach(() => {
    if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = saved.NODE_ENV
    if (saved.DATABASE_URL === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = saved.DATABASE_URL
    resetEnvCache()
  })

  it('refuse la connexion PostgreSQL de développement', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.DATABASE_URL
    resetEnvCache()
    expect(() => env()).toThrow(/DATABASE_URL/)
  })

  it('accepte une DATABASE_URL explicite', () => {
    process.env.NODE_ENV = 'production'
    process.env.DATABASE_URL = 'postgres://platform@db.example.test:5432/platform'
    resetEnvCache()
    expect(env().DATABASE_URL).toBe('postgres://platform@db.example.test:5432/platform')
  })

  it('garde la valeur de développement hors production', () => {
    process.env.NODE_ENV = 'development'
    delete process.env.DATABASE_URL
    resetEnvCache()
    expect(env().DATABASE_URL).toContain('localhost:5432')
  })
})
