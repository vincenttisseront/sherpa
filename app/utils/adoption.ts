/** Lien vers l'assistant de reprise d'une stack existante (onglet Reprise du serveur, assistant ouvert). */
export const adoptLink = (serverId: string, endpointId: string, stack: string) =>
  `/servers/${serverId}?tab=adopt&endpoint=${encodeURIComponent(endpointId)}&stack=${encodeURIComponent(stack)}`
