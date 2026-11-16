import { describe, expect, it } from 'vitest'
import { alternativeImages } from '../../server/lib/image-sources'

describe('sources équivalentes d\'une image', () => {
  it('LinuxServer : lscr.io, ghcr.io et Docker Hub', () => {
    expect(alternativeImages('lscr.io/linuxserver/deluge:2.2.0')).toEqual(['ghcr.io/linuxserver/deluge:2.2.0', 'linuxserver/deluge:2.2.0'])
    expect(alternativeImages('linuxserver/sonarr')).toEqual(['lscr.io/linuxserver/sonarr:latest', 'ghcr.io/linuxserver/sonarr:latest'])
  })

  it('images officielles : ECR Public et miroir Google, et retour vers Docker Hub', () => {
    expect(alternativeImages('postgres:18-alpine')).toEqual(['public.ecr.aws/docker/library/postgres:18-alpine', 'mirror.gcr.io/library/postgres:18-alpine'])
    expect(alternativeImages('public.ecr.aws/docker/library/redis:7')).toEqual(['redis:7', 'mirror.gcr.io/library/redis:7'])
  })

  it('organisation : mêmes noms sur Docker Hub, ghcr.io et quay.io ; empreinte conservée', () => {
    expect(alternativeImages('ghcr.io/acme/app:1.2')).toEqual(['acme/app:1.2', 'quay.io/acme/app:1.2'])
    const d = `sha256:${'a'.repeat(64)}`
    expect(alternativeImages(`acme/app@${d}`)).toContain(`ghcr.io/acme/app@${d}`)
  })

  it('registre privé ou chemin profond : aucune proposition', () => {
    expect(alternativeImages('registry.example.org/team/app:1')).toEqual([])
    expect(alternativeImages('ghcr.io/org/group/app:1')).toEqual([])
  })
})
