/**
 * Remplace window.confirm : renvoie une promesse résolue par la boîte de
 * confirmation custom (UiConfirmHost). Pour une action destructive, on peut
 * exiger la saisie d'un texte (ex. le nom de la ressource).
 */
export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** Si défini, l'utilisateur doit saisir exactement ce texte pour confirmer. */
  requireText?: string
}

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

const current = shallowRef<ConfirmState | null>(null)

export function useConfirm() {
  return (opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
    current.value?.resolve(false)
    current.value = { ...opts, resolve }
  })
}

export function useConfirmState() {
  return current
}
