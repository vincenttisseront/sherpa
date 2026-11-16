export interface Toast {
  id: number
  tone: 'success' | 'danger' | 'info' | 'warning'
  message: string
}

const toasts = ref<Toast[]>([])
let seq = 0

export function useToast() {
  const push = (tone: Toast['tone'], message: string, ttlMs = 5000) => {
    const id = ++seq
    toasts.value.push({ id, tone, message })
    if (ttlMs > 0) setTimeout(() => dismiss(id), ttlMs)
  }
  const dismiss = (id: number) => {
    toasts.value = toasts.value.filter(t => t.id !== id)
  }
  return {
    toasts,
    dismiss,
    success: (m: string) => push('success', m),
    error: (m: string) => push('danger', m, 8000),
    info: (m: string) => push('info', m),
    warning: (m: string) => push('warning', m),
  }
}
