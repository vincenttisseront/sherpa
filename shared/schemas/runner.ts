export interface RunnerDto {
  configured: boolean
  url: string | null
  caCertPem: string | null
  serverName: string | null
  maxConcurrentBuilds: number
  status: 'unconfigured' | 'online' | 'offline' | 'error'
  version: string | null
  hostname: string | null
  hostRoots: string[]
  lastCheckedAt: string | null
  lastError: string | null
  /** Empreinte courte de la clé HMAC, pour vérifier la configuration de l'hôte sans la révéler. */
  keyFingerprint: string | null
  platformIdentity: boolean
  adapter: 'mock' | 'http'
  /** Hôte joint en SSH : aucun Runner à installer, actions par SFTP et API Docker ; racines = chemins configurés. */
  viaSsh: boolean
  sshRoots: string[]
}

export type StepStatus = 'ok' | 'warning' | 'error' | 'skipped'
export interface DiagnosticStep { key: string, label: string, status: StepStatus, detail: string, durationMs: number }
export interface DiagnosticResult { ok: boolean, steps: DiagnosticStep[] }
