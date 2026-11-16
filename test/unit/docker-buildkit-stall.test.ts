import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDockerClient } from '../../runner/docker'

/** Faux moteur Docker : le build BuildKit (version=2) ne renvoie jamais rien ; le builder classique répond. */
describe('BuildKit sans progression', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dk-'))
  const socket = join(dir, 'docker.sock')
  const calls: string[] = []
  let server: Server
  beforeAll(async () => {
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n')
    server = createServer((req, res) => {
      calls.push(req.url!.includes('version=2') ? 'buildkit' : 'classic')
      req.resume()
      if (req.url!.includes('version=2')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.flushHeaders()
        return
      }
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(`${JSON.stringify({ stream: 'Step 1/1 : FROM scratch\n' })}\n${JSON.stringify({ aux: { ID: `sha256:${'a'.repeat(64)}` } })}\n`)
      })
    })
    await new Promise<void>(r => server.listen(socket, r))
  })
  afterAll(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('abandon après le délai, puis build avec le builder classique', async () => {
    const docker = createDockerClient(socket)
    const lines: string[] = []
    const t0 = Date.now()
    const r = await docker.build({ contextDir: dir, dockerfile: 'Dockerfile', tag: 'platform/x:1', buildArgs: {}, labels: {}, timeoutMs: 30_000, maxLogBytes: 1e6, buildkit: true, buildkitStallMs: 300, onLog: l => lines.push(l) })
    expect(r.imageId).toBe(`sha256:${'a'.repeat(64)}`)
    expect(calls).toEqual(['buildkit', 'classic'])
    expect(lines.some(l => l.startsWith('BuildKit indisponible (BuildKit : aucune progression reçue en'))).toBe(true)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})
