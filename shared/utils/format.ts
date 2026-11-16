/** Taille lisible en français : 512 o, 3,4 Ko, 12,0 Mo, 1,5 Go. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`
  const units = ['Ko', 'Mo', 'Go', 'To']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`
}

/** Durée lisible : « 45 s », « 3 min 12 s ». */
export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec} s`
  const m = Math.floor(sec / 60)
  return m < 60 ? `${m} min ${String(sec % 60).padStart(2, '0')} s` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}
