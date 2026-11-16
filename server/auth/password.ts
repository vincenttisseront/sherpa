/**
 * Mots de passe des comptes locaux (§15) : Argon2id, paramètres OWASP
 * (19 Mio, 2 itérations, parallélisme 1). Vérification à temps comparable
 * même pour un compte inexistant (pas d'énumération par chronométrage).
 */
import { hash, verify } from '@node-rs/argon2'

const ARGON2ID = 2
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const

export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 128

let dummy: Promise<string> | undefined

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS)
}

/** Vérifie un mot de passe ; sans hash (compte absent), consomme le même temps et renvoie false. */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  dummy ??= hashPassword('compte-inexistant-pour-egaliser-le-temps')
  try {
    return await verify(stored ?? await dummy, password) && stored !== null
  }
  catch {
    return false
  }
}

const COMMON = new Set(['motdepasse123', 'password1234', 'azertyuiop12', 'qwertyuiop12', '123456789012', 'administrateur', 'portainer123', 'changeme1234', 'bienvenue123'])

/** Politique de mot de passe (longueur avant tout, recommandation NIST/ANSSI). Renvoie un message ou null. */
export function checkPasswordPolicy(password: string, email?: string): string | null {
  if (password.length < PASSWORD_MIN) return `${PASSWORD_MIN} caractères minimum`
  if (password.length > PASSWORD_MAX) return `${PASSWORD_MAX} caractères maximum`
  if (/^(.)\1+$/.test(password)) return 'Mot de passe trop simple'
  if (COMMON.has(password.toLowerCase())) return 'Mot de passe trop courant'
  const local = email?.split('@')[0]?.toLowerCase()
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) return 'Le mot de passe ne doit pas contenir l\'identifiant'
  if (new Set(password).size < 6) return 'Mot de passe trop peu varié'
  return null
}
