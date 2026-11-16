/**
 * Attente de la propagation d'un enregistrement TXT (défi DNS-01) : interrogé sur des résolveurs
 * publics jusqu'à ce que la valeur apparaisse, ou la durée écoulée (l'autorité vérifie de toute
 * façon elle-même ; un réseau sans accès DNS public attend simplement la durée prévue).
 */
import { Resolver } from 'node:dns/promises'

export async function waitForTxt(fqdn: string, value: string, maxSec: number, opts: { servers?: string[], stepMs?: number } = {}): Promise<boolean> {
  if (maxSec <= 0) return false
  const resolver = new Resolver({ timeout: 3000, tries: 1 })
  resolver.setServers(opts.servers ?? ['1.1.1.1', '8.8.8.8'])
  const step = opts.stepMs ?? 5000
  const deadline = Date.now() + maxSec * 1000
  while (Date.now() < deadline) {
    const found = await resolver.resolveTxt(fqdn).then(r => r.some(chunks => chunks.join('') === value)).catch(() => false)
    if (found) return true
    await new Promise(r => setTimeout(r, Math.min(step, Math.max(0, deadline - Date.now()))))
  }
  return false
}
