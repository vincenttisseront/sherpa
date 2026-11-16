/** Identifiant de projet : minuscules, sans accents, tout autre caractère devient un tiret. */
export function slugify(v: string): string {
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

/** Identifiant final déduit d'un nom (sans tiret en bord, 63 caractères au plus). */
export function slugFromName(name: string): string {
  return slugify(name).replace(/^-+|-+$/g, '').slice(0, 63)
}

/** Saisie manuelle normalisée au fil de la frappe (un tiret final reste possible pendant la saisie). */
export function slugTyping(v: string): string {
  return slugify(v).replace(/^-+/, '').slice(0, 63)
}
