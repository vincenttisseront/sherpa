/**
 * Thème d'affichage : système (défaut), clair ou sombre. Préférence propre au
 * navigateur (localStorage), appliquée avant le rendu par un script en ligne
 * (autorisé par empreinte dans la CSP) pour éviter le flash.
 */
export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'pp:theme'

export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem('${KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`

export function useTheme() {
  const choice = useState<ThemeChoice>('theme', () => 'system')
  onMounted(() => {
    try {
      const t = localStorage.getItem(KEY)
      if (t === 'light' || t === 'dark') choice.value = t
    }
    catch { /* stockage indisponible : thème du système */ }
  })
  function set(t: ThemeChoice) {
    choice.value = t
    const el = document.documentElement
    if (t === 'system') delete el.dataset.theme
    else el.dataset.theme = t
    try {
      if (t === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, t)
    }
    catch { /* ignoré */ }
  }
  function cycle() {
    set(choice.value === 'system' ? 'dark' : choice.value === 'dark' ? 'light' : 'system')
  }
  return { choice, set, cycle }
}
