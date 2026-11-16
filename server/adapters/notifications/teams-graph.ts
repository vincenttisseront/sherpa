/**
 * Teams via Microsoft Graph : abstraction prévue (§18).
 * La publication dans un canal exige une identité déléguée (les permissions
 * applicatives ne le permettent pas hors migration) : l'adaptateur sera branché
 * avec ce flux. Le moteur et le dispatcher n'auront pas à changer.
 */
import { teamsGraphConfig } from '../../../shared/schemas/notifications'
import { type NotificationAdapter, NotificationError } from './types'

export const teamsGraphAdapter: NotificationAdapter = {
  kind: 'teams_graph',
  async send(config) {
    teamsGraphConfig.parse(config)
    throw new NotificationError('Adaptateur Microsoft Graph non activé sur cette instance : utiliser un webhook Teams', false)
  },
}
