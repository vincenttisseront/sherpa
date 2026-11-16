import { and, asc, eq, isNull } from 'drizzle-orm'
import type { PathConfigInput, PortRuleInput, TraefikConfigInput } from '../../shared/schemas/infra'
import { db, schema } from '../db/client'
import { environmentMaps } from './servers'

export interface EndpointConfigDto {
  paths: Record<string, PathConfigInput & { updatedAt: string }>
  portRules: PortRuleInput[]
  traefik: TraefikConfigInput | null
}

export async function loadEndpointConfig(endpointId: string): Promise<EndpointConfigDto> {
  const { keyById } = await environmentMaps()
  const [paths, rules, [traefik]] = await Promise.all([
    db().select().from(schema.pathConfigs).where(eq(schema.pathConfigs.endpointId, endpointId)),
    db().select().from(schema.portRules).where(eq(schema.portRules.endpointId, endpointId)).orderBy(asc(schema.portRules.portFrom)),
    db().select().from(schema.traefikConfigs).where(and(eq(schema.traefikConfigs.endpointId, endpointId), isNull(schema.traefikConfigs.environmentId))),
  ])
  return {
    paths: Object.fromEntries(paths.map(p => [keyById.get(p.environmentId)!, {
      workingRoot: p.workingRoot, buildRoot: p.buildRoot, tmpRoot: p.tmpRoot, runtimeRoot: p.runtimeRoot,
      autoCreate: p.autoCreate, dirMode: p.dirMode, ownerUid: p.ownerUid, groupGid: p.groupGid,
      minFreeDiskMb: p.minFreeDiskMb, maxProjectSizeMb: p.maxProjectSizeMb, releasesToKeep: p.releasesToKeep,
      retentionDays: p.retentionDays, forbiddenPaths: p.forbiddenPaths, updatedAt: p.updatedAt.toISOString(),
    }])),
    portRules: rules.map(r => ({
      portFrom: r.portFrom, portTo: r.portTo, protocol: r.protocol, policy: r.policy,
      environmentKey: (r.environmentId ? keyById.get(r.environmentId) ?? null : null) as PortRuleInput['environmentKey'],
      description: r.description,
    })),
    traefik: traefik
      ? {
          networkName: traefik.networkName, certResolver: traefik.certResolver, entrypointHttp: traefik.entrypointHttp,
          entrypointHttps: traefik.entrypointHttps, allowedDomains: traefik.allowedDomains, defaultMiddlewares: traefik.defaultMiddlewares,
          routerNamePattern: traefik.routerNamePattern, exposure: traefik.exposure, redirectToHttps: traefik.redirectToHttps,
          provider: traefik.provider, letsencrypt: traefik.letsencrypt, nginxContainer: traefik.nginxContainer, nginxConfDir: traefik.nginxConfDir,
          nginxSslCertificate: traefik.nginxSslCertificate, nginxSslCertificateKey: traefik.nginxSslCertificateKey,
          nginxCertsDir: traefik.nginxCertsDir, nginxAcmeEmail: traefik.nginxAcmeEmail, nginxAcmeDirectory: traefik.nginxAcmeDirectory, nginxAccessLog: traefik.nginxAccessLog,
        }
      : null,
  }
}
