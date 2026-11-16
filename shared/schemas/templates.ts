import { z } from 'zod'

/** Variable d'un modèle : saisie à l'application du modèle, enregistrée comme variable de la cible (secrète si demandé). */
export interface TemplateVariable {
  name: string
  label: string
  default?: string
  secret?: boolean
  /** Valeur générée (aléatoire) proposée par défaut. */
  generate?: 'password' | 'hex'
  description?: string
}

export const TEMPLATE_CATEGORIES = ['Bases de données', 'Applications', 'Supervision', 'Stockage', 'Développement', 'Personnalisé'] as const
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]

export interface TemplateDto {
  /** `builtin:<clé>` pour les modèles fournis, UUID pour les modèles de la plateforme. */
  id: string
  name: string
  description: string
  category: TemplateCategory
  builtin: boolean
  compose: string
  variables: TemplateVariable[]
  /** Services à exposer (onglet Exposition) : conseil affiché après l'application. */
  notes: string | null
  createdBy: string | null
  createdAt: string | null
}

export const templateInput = z.object({
  name: z.string().trim().min(2, '2 caractères minimum').max(80),
  description: z.string().trim().max(300).default(''),
  compose: z.string().min(20, 'Compose trop court').max(128 * 1024, 'Compose trop volumineux (128 Ko maximum)'),
})
export type TemplateInput = z.infer<typeof templateInput>
