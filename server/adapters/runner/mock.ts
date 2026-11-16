/**
 * Target Runner simulé : système de fichiers en mémoire, build factice.
 * Il applique la même validation d'entrée que le vrai Runner.
 */
import { createHash } from 'node:crypto'
import { normalizeAbsolute, assertNotSensitive } from '../../utils/path-guard'
import type { RunnerAction, TargetRunner } from './types'
import { runnerActions, validateRunnerInput } from './types'

export function createMockRunner(): TargetRunner {
  const dirs = new Set<string>()
  const files = new Map<string, Buffer>()

  const checkPath = (p: string) => {
    const n = normalizeAbsolute(p)
    assertNotSensitive(n)
    return n
  }

  return {
    async health() {
      return { version: 'mock-0.1.0', actions: Object.keys(runnerActions) as RunnerAction[], roots: ['/srv'], hostname: 'mock' }
    },
    async checkDir(_ctx, input) {
      const p = checkPath(validateRunnerInput('checkDir', input).path)
      const exists = dirs.has(p)
      return { exists, writable: exists, isDirectory: exists }
    },
    async ensureDir(_ctx, input) {
      const p = checkPath(validateRunnerInput('ensureDir', input).path)
      const parts = p.split('/').filter(Boolean)
      for (let i = 1; i <= parts.length; i++) dirs.add(`/${parts.slice(0, i).join('/')}`)
    },
    async uploadFile(_ctx, input, data) {
      const { path, sha256, sizeBytes } = validateRunnerInput('uploadFile', input)
      const p = checkPath(path)
      const chunks: Buffer[] = []
      for await (const c of data) chunks.push(Buffer.from(c))
      const buf = Buffer.concat(chunks)
      if (buf.length !== sizeBytes) throw new Error('Taille du fichier reçue différente de la taille annoncée')
      if (createHash('sha256').update(buf).digest('hex') !== sha256) throw new Error('Empreinte SHA-256 invalide')
      files.set(p, buf)
    },
    async extractArchive(_ctx, input) {
      validateRunnerInput('extractArchive', input)
      const { destination } = validateRunnerInput('extractArchive', input)
      if (dirs.has(checkPath(destination))) throw new Error('La destination existe déjà')
      dirs.add(destination)
      files.set(`${destination}/compose.yml`, Buffer.from('services: {}\n'))
      return { files: 3, directories: 1, totalBytes: 2048, composeFiles: ['compose.yml'], dockerfiles: ['Dockerfile'], rootFolder: null }
    },
    async hashTree(_ctx, input) {
      const p = checkPath(validateRunnerInput('hashTree', input).path)
      const h = createHash('sha256')
      let count = 0
      for (const [k, v] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
        if (k.startsWith(`${p}/`)) {
          h.update(k).update(v)
          count++
        }
      }
      return { sha256: h.digest('hex'), files: count }
    },
    async prepareBuildContext(_ctx, input) {
      validateRunnerInput('prepareBuildContext', input)
      return { sizeBytes: 2048 }
    },
    async build(_ctx, input, onLog) {
      const { imageTag } = validateRunnerInput('build', input)
      const lines = ['#1 [internal] load build definition from Dockerfile', '#2 [1/3] FROM docker.io/library/node:24-alpine', '#3 [3/3] RUN npm ci', `#4 naming to ${imageTag} done`]
      for (const line of lines) onLog({ ts: new Date().toISOString(), stream: 'stdout', line })
      return { imageId: `sha256:${createHash('sha256').update(imageTag).digest('hex')}`, imageTag, durationMs: 1200, contextBytes: 2048 }
    },
    async diskUsage(_ctx, input) {
      checkPath(validateRunnerInput('diskUsage', input).path)
      return { totalBytes: 100 * 1024 ** 3, freeBytes: 60 * 1024 ** 3 }
    },
    async writeFile(_ctx, input) {
      const { path, content } = validateRunnerInput('writeFile', input)
      files.set(checkPath(path), Buffer.from(content))
      return { sha256: createHash('sha256').update(content).digest('hex') }
    },
    async removeImages(_ctx, input) {
      return { removed: validateRunnerInput('removeImages', input).tags, missing: [], failed: [] }
    },
    async pathExists(_ctx, input) {
      const p = checkPath(validateRunnerInput('pathExists', input).path)
      return { exists: dirs.has(p) || files.has(p) }
    },
    async cleanup(_ctx, input) {
      const p = checkPath(validateRunnerInput('cleanup', input).path)
      let removed = 0
      for (const d of dirs) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d)
      for (const [k, v] of files) {
        if (k === p || k.startsWith(`${p}/`)) {
          removed += v.length
          files.delete(k)
        }
      }
      return { removedBytes: removed }
    },
  }
}
