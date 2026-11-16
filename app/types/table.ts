export interface Column<R> {
  key: string
  label: string
  sortable?: boolean
  align?: 'left' | 'right'
  width?: string
  value?: (row: R) => unknown
  /** Masquée tant que l'utilisateur ne l'affiche pas. */
  defaultHidden?: boolean
  /** false : jamais exportée (colonne d'actions). */
  exportable?: boolean
  /** Masquée sur petit écran (< 720 px) : colonne secondaire. */
  mobileHidden?: boolean
}

/** État d'un tableau ; les filtres propres à chaque tableau s'y ajoutent (combinables). */
export interface TableState {
  page: number
  pageSize: number
  sort?: string
  q?: string
  period?: string
  from?: string
  to?: string
  [filter: string]: unknown
}

/** État initial d'un tableau à partir de l'URL (liens du tableau de bord). */
export function stateFromRoute(defaults: TableState, routeQuery: Record<string, unknown>, keys: string[]): TableState {
  const s: TableState = { ...defaults }
  for (const k of ['q', 'period', 'from', 'to', 'sort', ...keys]) {
    const v = routeQuery[k]
    if (typeof v === 'string' && v) s[k] = v
  }
  return s
}
