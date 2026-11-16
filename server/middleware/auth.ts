/**
 * Authentification et protections transverses de l'API (§15, §19).
 *
 * - session serveur (cookie httpOnly) → utilisateur et droits effectifs ;
 * - ou jeton d'API (en-tête Bearer shp_…) → droits de son propriétaire réduits à ceux du jeton, sans CSRF ;
 * - requêtes modifiantes : origine vérifiée, et jeton CSRF de la session exigé ;
 * - limitation de débit par utilisateur, ou par adresse IP sans session ;
 * - fermé par défaut : toute route hors liste publique exige une session.
 * DEV_AUTH_BYPASS (développement uniquement, refusé en production) injecte un administrateur fictif.
 */
import { createError, defineEventHandler, getRequestHeader, getRequestURL } from 'h3'
import { BUILTIN_ROLES } from '../../shared/utils/permissions'
import { resolveApiToken } from '../auth/api-tokens'
import { loadGrants } from '../auth/grants'
import { enforceRateLimit } from '../auth/rate-limit'
import { resolveSession } from '../auth/sessions'
import { clientIp } from '../utils/auth'
import { safeEqual } from '../utils/crypto'
import { env } from '../utils/env'

const PUBLIC = ['/api/health', '/api/auth/login', '/api/auth/mfa/', '/api/auth/passkey/', '/api/auth/logout', '/api/auth/me', '/api/auth/setup', '/api/auth/providers', '/api/auth/oidc/', '/api/auth/invitations/', '/api/watchtower/hook/', '/api/watchtower/profile-hook/', '/api/webhooks/github/']
const isPublic = (p: string) => PUBLIC.some(x => p === x || (x.endsWith('/') && p.startsWith(x)))
/** Session en attente d'activation de la double authentification : seules ces routes répondent. */
const MFA_PENDING_OK = ['/api/health', '/api/auth/', '/api/account/mfa']
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function allowedOrigins(event: Parameters<typeof getRequestURL>[0]): Set<string> {
  const origins = new Set([new URL(env().APP_URL).origin])
  const host = getRequestHeader(event, 'host')
  if (host) {
    origins.add(`http://${host}`)
    origins.add(`https://${host}`)
  }
  return origins
}

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event)
  if (!url.pathname.startsWith('/api/')) return
  const unsafe = UNSAFE.has(event.method)

  // Origine : un navigateur envoie toujours Origin sur une requête modifiante.
  const origin = getRequestHeader(event, 'origin')
  if (unsafe && origin && !allowedOrigins(event).has(origin)) {
    throw createError({ statusCode: 403, statusMessage: 'Origine de la requête refusée' })
  }

  // Jeton d'API : jamais pour gérer son compte ou ses jetons (session seulement) ; aucun CSRF (pas de cookie).
  const authorization = getRequestHeader(event, 'authorization')
  if (authorization?.startsWith('Bearer shp_')) {
    if (url.pathname.startsWith('/api/account') || (url.pathname.startsWith('/api/auth/') && url.pathname !== '/api/auth/me')) {
      throw createError({ statusCode: 403, statusMessage: 'Un jeton d\'API ne peut pas gérer le compte ni ouvrir de session' })
    }
    const t = await resolveApiToken(authorization.slice('Bearer '.length), clientIp(event))
    if (!t) throw createError({ statusCode: 401, statusMessage: 'Jeton d\'API invalide, expiré ou révoqué' })
    await enforceRateLimit(event, `token:${t.id}`, 600, 60)
    // L'audit et les journaux montrent le jeton : « personne@exemple (jeton ci-github) ».
    event.context.user = { id: t.user.id, email: `${t.user.email} (jeton ${t.name})`, displayName: t.user.displayName, kind: t.user.kind, grants: t.grants }
    event.context.apiToken = { id: t.id, name: t.name }
    return
  }

  if (env().DEV_AUTH_BYPASS) {
    event.context.user = { id: null, email: 'dev-admin@localhost', displayName: 'Admin (dev)', kind: 'dev', grants: [{ permissions: BUILTIN_ROLES.admin.permissions, scope: {} }] }
    return
  }

  const session = await resolveSession(event)
  if (session) {
    event.context.session = { id: session.id, csrfToken: session.csrfToken, idpId: session.idpId, mfaPending: session.mfaPending }
    event.context.user = {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      kind: session.user.kind,
      grants: await loadGrants(session.user.id),
    }
    if (unsafe && !isPublic(url.pathname)) {
      const token = getRequestHeader(event, 'x-csrf-token') ?? ''
      if (!session.csrfToken || !safeEqual(token, session.csrfToken)) {
        throw createError({ statusCode: 403, statusMessage: 'Jeton CSRF absent ou invalide : recharger la page' })
      }
    }
    await enforceRateLimit(event, `user:${session.user.id}`, 600, 60)
    if (session.mfaPending && !MFA_PENDING_OK.some(x => url.pathname === x || url.pathname.startsWith(`${x}/`) || (x.endsWith('/') && url.pathname.startsWith(x)))) {
      throw createError({ statusCode: 403, statusMessage: 'Double authentification requise : l\'activer depuis la page Mon compte', data: { mfaEnrollRequired: true } })
    }
    return
  }

  await enforceRateLimit(event, `ip:${clientIp(event)}`, 120, 60)
  if (!isPublic(url.pathname)) throw createError({ statusCode: 401, statusMessage: 'Authentification requise' })
})
