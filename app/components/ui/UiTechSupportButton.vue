<script setup lang="ts">
/**
 * Export « tech support » : le rapport peut demander jusqu'à une minute (sondes réseau, routes de
 * santé lentes). Bouton avec spinner et temps écoulé, téléchargement à la fin, erreur affichée.
 */
import { Download } from 'lucide-vue-next'

const props = defineProps<{ href: string, title?: string }>()
const toast = useToast()
const loading = ref(false)
const elapsed = ref(0)

async function run() {
  if (loading.value) return
  loading.value = true
  elapsed.value = 0
  const timer = setInterval(() => elapsed.value++, 1000)
  try {
    const res = await fetch(props.href, { credentials: 'same-origin' })
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { message?: string, statusMessage?: string } | null
      throw new Error(body?.message ?? body?.statusMessage ?? `Erreur ${res.status}`)
    }
    const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'tech-support.txt'
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  catch (err) {
    toast.error(`Export tech support impossible : ${(err as Error).message}`)
  }
  finally {
    clearInterval(timer)
    loading.value = false
  }
}
</script>

<template>
  <UiButton size="sm" variant="ghost" :loading="loading" :title="title" @click="run">
    <Download v-if="!loading" :size="13" />
    {{ loading ? `Génération du rapport… ${elapsed} s` : 'Export tech support' }}
  </UiButton>
</template>
