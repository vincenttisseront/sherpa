/**
 * Sources équivalentes d'une image : mêmes images publiées sur plusieurs registres
 * (LinuxServer sur lscr.io, ghcr.io et Docker Hub ; images officielles de Docker Hub
 * recopiées sur Amazon ECR Public et le miroir de Google ; organisations publiant sur
 * ghcr.io ou quay.io et Docker Hub). Seules des candidates : chacune est vérifiée
 * auprès de son registre avant d'être proposée.
 */
import { type ImageRef, parseImageRef } from './registry'

function format(registry: string, repository: string, ref: ImageRef): string {
  const name = registry === 'docker.io' ? repository.replace(/^library\//, '') : `${registry}/${repository}`
  return `${name}${ref.digest ? `@${ref.digest}` : `:${ref.tag ?? 'latest'}`}`
}

export function alternativeImages(image: string): string[] {
  const ref = parseImageRef(image)
  if (!ref) return []
  const reg = ref.registry === 'index.docker.io' || ref.registry === 'registry-1.docker.io' ? 'docker.io' : ref.registry
  const repo = ref.repository
  const out: [string, string][] = []
  if (repo.startsWith('linuxserver/') && ['lscr.io', 'ghcr.io', 'docker.io'].includes(reg)) {
    for (const r of ['lscr.io', 'ghcr.io', 'docker.io']) out.push([r, repo])
  }
  else if (reg === 'docker.io' && repo.startsWith('library/')) {
    out.push(['public.ecr.aws', `docker/${repo}`], ['mirror.gcr.io', repo])
  }
  else if ((reg === 'public.ecr.aws' && repo.startsWith('docker/library/')) || (reg === 'mirror.gcr.io' && repo.startsWith('library/'))) {
    const lib = repo.replace(/^docker\//, '')
    out.push(['docker.io', lib], ['public.ecr.aws', `docker/${lib}`], ['mirror.gcr.io', lib])
  }
  else if (['ghcr.io', 'quay.io', 'docker.io'].includes(reg) && repo.split('/').length === 2) {
    for (const r of ['docker.io', 'ghcr.io', 'quay.io']) out.push([r, repo])
  }
  const self = format(reg, repo, ref)
  return [...new Set(out.map(([r, p]) => format(r, p, ref)))].filter(x => x !== self)
}
