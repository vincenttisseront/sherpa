/**
 * Stacks communes aux transports (agent, SSH) : des projets Compose déployés
 * par la console (`docker compose` relayé vers l'hôte). Une stack existe tant
 * que des conteneurs portent son nom de projet et le label platform.managed.
 */
import { crc32 } from 'node:zlib'
import YAML from 'yaml'
import { runCompose } from './compose'
import type { DockerOps } from './http'
import type { PortainerAdapter, PortainerConnection, PortainerStack, StackDeployInput } from './types'
import { PortainerError } from './types'

/** Un hôte = un endpoint (identifiant 1), quel que soit le transport. */
export const HOST_ENDPOINT_ID = 1

/** Identifiant stable d'une stack (nom de projet Compose) pour le modèle commun. */
export function agentStackId(name: string): number {
  return (crc32(name) & 0x7FFFFFFF) || 1
}

/**
 * Services dont l'image vient d'un registre : les seuls à récupérer à nouveau lors
 * d'une mise à jour manuelle. Les images construites par la plateforme (platform/…)
 * n'existent que sur l'hôte : `--pull always` échouerait sur elles.
 */
export function registryServices(composeContent: string): string[] {
  return Object.keys(registryImages(composeContent))
}

/** Service → image, pour les services dont l'image ne vient pas d'un build de la plateforme. */
export function registryImages(composeContent: string): Record<string, string> {
  const doc = YAML.parse(composeContent) as { services?: Record<string, { image?: unknown, pull_policy?: unknown }> } | null
  return Object.fromEntries(Object.entries(doc?.services ?? {})
    .filter(([, svc]) => typeof svc?.image === 'string' && !svc.image.startsWith('platform/') && svc.pull_policy !== 'never')
    .map(([name, svc]) => [name, svc.image as string]))
}

type StackOps = Pick<PortainerAdapter, 'listStacks' | 'findStack' | 'createStack' | 'updateStack' | 'stopStack' | 'startStack' | 'deleteStack'>

export function composeStackOps(base: DockerOps, longMs: number): StackOps {
  async function stacks(conn: PortainerConnection): Promise<PortainerStack[]> {
    const containers = await base.listContainers(conn, HOST_ENDPOINT_ID)
    const byName = new Map<string, boolean>()
    for (const c of containers) {
      const name = c.labels['com.docker.compose.project']
      if (!name || c.labels['platform.managed'] !== 'true') continue
      byName.set(name, (byName.get(name) ?? false) || c.state === 'running')
    }
    return [...byName.entries()].map(([name, running]) => ({ id: agentStackId(name), name, endpointId: HOST_ENDPOINT_ID, status: running ? 'active' : 'inactive', type: 'compose' }))
  }

  async function nameOf(conn: PortainerConnection, stackId: number): Promise<string> {
    const s = (await stacks(conn)).find(x => x.id === stackId)
    if (!s) throw new PortainerError(`Stack ${stackId} introuvable sur l'hôte`, 'not_found', 404)
    return s.name
  }

  /**
   * Récupération des images de registre avant une mise à jour. Un échec n'est bloquant que pour
   * une image absente de l'hôte : une image présente (construite ou chargée sur l'hôte, registre
   * privé sans identifiants…) est conservée, avec un avertissement dans le journal.
   */
  async function pullImages(conn: PortainerConnection, input: StackDeployInput, images: Record<string, string>): Promise<void> {
    const run = (services: string[]) => runCompose(conn, { args: ['-p', input.name, '-f', '-', 'pull', ...services], stdin: input.composeContent, env: input.env, timeoutMs: longMs })
    try {
      await run(Object.keys(images))
      return
    }
    catch {
      // Un service en échec interrompt les autres : reprise service par service.
    }
    const kept: string[] = []
    for (const [service, image] of Object.entries(images)) {
      const present = await base.imageInfo(conn, HOST_ENDPOINT_ID, image).catch(() => null)
      try {
        await run([service])
      }
      catch (err) {
        if (!present) throw err
        const reason = (err as Error).message.match(/(pull access denied|manifest unknown|not found|unauthorized|denied|timeout|no such host)[^|]{0,80}/i)?.[0] ?? 'registre injoignable ou image inconnue'
        kept.push(`${service} (${image} : ${reason.trim()})`)
      }
    }
    if (kept.length) await input.onWarning?.(`Images non récupérées, version présente sur l'hôte conservée : ${kept.join(' ; ')}`)
  }

  /**
   * Conteneurs étrangers à la stack branchés sur ses réseaux (services non gérés détachés de la
   * stack, conteneurs d'autres stacks) : ils empêchent Compose de supprimer ces réseaux.
   */
  async function outsiders(conn: PortainerConnection, stack: string): Promise<{ network: string, id: string, name: string, aliases: string[] }[]> {
    const nets = (await base.listNetworks(conn, HOST_ENDPOINT_ID)).filter(n => n.labels['com.docker.compose.project'] === stack)
    if (!nets.length) return []
    const containers = await base.listContainers(conn, HOST_ENDPOINT_ID)
    const out: { network: string, id: string, name: string, aliases: string[] }[] = []
    for (const n of nets) {
      const detail = await base.inspectNetwork(conn, HOST_ENDPOINT_ID, n.id)
      for (const c of detail?.containers ?? []) {
        if (containers.find(x => x.id === c.id)?.labels['com.docker.compose.project'] === stack) continue
        const cfg = await base.inspectConfig(conn, HOST_ENDPOINT_ID, c.id).catch(() => null)
        // Alias à rétablir (nom de service…), sans le nom ni l'identifiant du conteneur, ajoutés par Docker.
        const aliases = (cfg?.networks.find(x => x.name === n.name)?.aliases ?? []).filter(a => !c.id.startsWith(a) && a !== cfg?.name && a !== c.name)
        out.push({ network: n.name, id: c.id, name: c.name, aliases })
      }
    }
    return out
  }

  /** Arrêt et suppression de la stack, réseaux compris : les conteneurs étrangers en sont d'abord débranchés. */
  async function down(conn: PortainerConnection, args: { name: string, composeContent?: string, env?: StackDeployInput['env'] }) {
    const strangers = await outsiders(conn, args.name)
    for (const s of strangers) await base.disconnectNetwork(conn, HOST_ENDPOINT_ID, s.network, s.id)
    await runCompose(conn, { args: ['-p', args.name, ...(args.composeContent !== undefined ? ['-f', '-'] : []), 'down', '--remove-orphans'], stdin: args.composeContent, env: args.env, timeoutMs: longMs })
    return strangers
  }

  async function up(conn: PortainerConnection, input: StackDeployInput): Promise<PortainerStack> {
    const images = input.pullImage ? registryImages(input.composeContent) : {}
    const pull = Object.keys(images)
    if (pull.length) await pullImages(conn, input, images)
    const upArgs = { args: ['-p', input.name, '-f', '-', 'up', '-d', '--remove-orphans'], stdin: input.composeContent, env: input.env, timeoutMs: longMs }
    try {
      await runCompose(conn, upArgs)
    }
    catch (err) {
      // Réseau dont la configuration a changé (sous-réseau, options) : à recréer, stack arrêtée.
      // Compose récent : il recrée lui-même le réseau, et échoue si un conteneur hors stack y est branché.
      if (!/needs to be recreated|incorrect (label|config)|network .* has active endpoints/i.test((err as Error).message)) throw err
      await input.onWarning?.('Réseaux de la stack recréés (configuration modifiée) : stack arrêtée puis relancée, volumes conservés')
      const strangers = await down(conn, { name: input.name, composeContent: input.composeContent, env: input.env })
      if (strangers.length) await input.onWarning?.(`Conteneurs hors de la stack débranchés le temps de recréer ses réseaux, puis rebranchés : ${[...new Set(strangers.map(x => x.name))].join(', ')}`)
      try {
        await runCompose(conn, upArgs)
      }
      finally {
        // Rebranchés sur les réseaux recréés (même nom), avec leurs alias.
        for (const x of strangers) {
          await base.connectNetwork(conn, HOST_ENDPOINT_ID, x.network, x.id, x.aliases)
            .catch(err => input.onWarning?.(`${x.name} non rebranché sur ${x.network} : ${(err as Error).message} — le rebrancher à la main (docker network connect ${x.aliases.map(a => `--alias ${a} `).join('')}${x.network} ${x.name})`))
        }
      }
    }
    return { id: agentStackId(input.name), name: input.name, endpointId: HOST_ENDPOINT_ID, status: 'active', type: 'compose' }
  }

  return {
    listStacks: conn => stacks(conn),
    findStack: async (conn, name) => (await stacks(conn)).find(s => s.name === name) ?? null,
    createStack: (conn, input) => up(conn, input),
    updateStack: (conn, _stackId, input) => up(conn, input),
    async stopStack(conn, stackId) {
      await runCompose(conn, { args: ['-p', await nameOf(conn, stackId), 'stop'], timeoutMs: longMs })
    },
    async startStack(conn, stackId) {
      await runCompose(conn, { args: ['-p', await nameOf(conn, stackId), 'start'], timeoutMs: longMs })
    },
    async deleteStack(conn, stackId) {
      // Les volumes sont conservés, comme pour une stack Portainer.
      await down(conn, { name: await nameOf(conn, stackId) })
    },
  }
}
