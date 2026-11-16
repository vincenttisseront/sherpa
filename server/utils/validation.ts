import type { H3Event } from 'h3'
import { createError, readBody } from 'h3'
import { z } from 'zod'
import type { FieldErrors } from '../../shared/schemas/infra'

export const idParam = z.object({ id: z.uuid() })

/** 422 avec erreurs par champ, exploitables par les formulaires. */
export function validationError(errors: FieldErrors, message = 'Données invalides') {
  return createError({ statusCode: 422, statusMessage: message, data: { errors } })
}

/** Code Postgres d'une erreur, y compris encapsulée par Drizzle. */
export function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string, cause?: { code?: string } }
  return e.cause?.code ?? e.code
}

/** Convertit les erreurs Zod en erreurs par champ (`a.b.0.c`). */
export function zodFieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {}
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || '_'
    errors[key] ??= issue.message
  }
  return errors
}

/** Lit et valide le corps ; en cas d'échec, 422 avec erreurs par champ (et non un 400 opaque). */
export async function readValidated<S extends z.ZodType>(event: H3Event, schema: S): Promise<z.infer<S>> {
  const body = await readBody(event).catch(() => undefined)
  const r = schema.safeParse(body)
  if (!r.success) throw validationError(zodFieldErrors(r.error))
  return r.data
}
