import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import type { Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpRunner } from '../../server/adapters/runner/http'
import type { TargetRunner } from '../../server/adapters/runner/types'
import { createRunnerServer } from '../../runner/server'
import { generatePki } from '../../scripts/pki'

/** Démarre un vrai Runner (HTTPS + mTLS) sur un port libre et renvoie un client connecté. */
export async function startTestRunner(roots: string[], audit: (e: Record<string, unknown>) => void = () => {}, dockerSocket: string | null = null) {
  const pki = generatePki(mkdtempSync(join(tmpdir(), 'runner-pki-')))
  const hmacKey = randomBytes(32)
  const server = createRunnerServer({
    port: 0, host: '127.0.0.1', roots, hmacKey,
    tls: { cert: pki.serverCert, key: pki.serverKey, ca: pki.caCert },
    maxUploadBytes: 50 * 1024 * 1024, maxConcurrent: 8, hostname: 'test-host',
    dockerSocket, maxBuilds: 2, buildMaxMemoryMb: 1024,
  }, audit) as Server
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `https://localhost:${(server.address() as AddressInfo).port}`
  const runner: TargetRunner = createHttpRunner({ url, hmacKey, caCertPem: pki.caCert, clientCertPem: pki.clientCert, clientKeyPem: pki.clientKey })
  return { server, url, runner, pki, hmacKey, close: () => new Promise<void>(r => server.close(() => r())) }
}

export function tempBase(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}
