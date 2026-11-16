export interface ViewerLine {
  id: string
  ts: string
  level: 'debug' | 'info' | 'warn' | 'error'
  phase: string
  service: string | null
  message: string
}
