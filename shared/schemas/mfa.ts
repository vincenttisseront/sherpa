import { z } from 'zod'

export const mfaPolicyInput = z.object({ required: z.enum(['off', 'admins', 'all']) })
export type MfaPolicyInput = z.infer<typeof mfaPolicyInput>

export interface MfaStatusDto {
  /** Compte local ou externe : la double authentification s'y configure (sinon, gérée par le fournisseur d'identité). */
  supported: boolean
  policy: 'off' | 'admins' | 'all'
  /** La politique impose un second facteur à ce compte. */
  required: boolean
  totp: boolean
  recoveryCodesLeft: number
  passkeys: { id: string, name: string, backedUp: boolean, createdAt: string, lastUsedAt: string | null }[]
}
