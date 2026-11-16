<script setup lang="ts">
/**
 * Certificats importés pour le Traefik géré (sans ACME, ou pour des domaines
 * précis) : liste (domaines, émetteur, expiration, domaines exposés couverts),
 * import d'un couple certificat / clé, certificat par défaut, suppression.
 * La clé privée n'est jamais réaffichée ; elle est effacée du formulaire après l'envoi.
 */
import { FileKey, Trash2, TriangleAlert, Upload } from 'lucide-vue-next'
import type { ProxyCertificateDto } from '#shared/schemas/managed-proxy'

const props = withDefaults(defineProps<{ endpointId: string, canManage: boolean, /** Traefik géré : certificats mis en service à son application. */ tracksApply?: boolean, intro?: string }>(), { tracksApply: true, intro: undefined })
const emit = defineEmits<{ changed: [] }>()
const toast = useToast()
const confirm = useConfirm()

const { data: certs, refresh } = await useFetch<ProxyCertificateDto[]>(() => `/api/endpoints/${props.endpointId}/managed-proxy/certificates`, { server: false })

const showForm = ref(false)
const certPem = ref('')
const keyPem = ref('')
const isDefault = ref(false)
const sending = ref(false)
const errors = ref<Record<string, string>>({})
const lastWarnings = ref<string[]>([])

async function readFile(e: Event, target: 'cert' | 'key') {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  if (f.size > 64 * 1024) {
    errors.value = { [target === 'cert' ? 'certPem' : 'keyPem']: 'Fichier trop volumineux (64 Ko maximum)' }
    return
  }
  const text = await f.text()
  if (target === 'cert') certPem.value = text
  else keyPem.value = text
  ;(e.target as HTMLInputElement).value = ''
}

async function submit() {
  sending.value = true
  errors.value = {}
  lastWarnings.value = []
  try {
    const r = await $fetch<{ certificate: ProxyCertificateDto, warnings: string[] }>(`/api/endpoints/${props.endpointId}/managed-proxy/certificates`, {
      method: 'POST',
      body: { certPem: certPem.value, keyPem: keyPem.value, isDefault: isDefault.value },
    })
    toast.success(`Certificat importé : ${r.certificate.domains.join(', ')} — appliquer le Traefik géré pour le mettre en service`)
    lastWarnings.value = r.warnings
    certPem.value = ''
    keyPem.value = ''
    isDefault.value = false
    showForm.value = false
    await refresh()
    emit('changed')
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    if (!Object.keys(e.errors).length) toast.error(e.message)
  }
  finally {
    // La clé ne reste jamais dans le formulaire, même en cas d'erreur.
    keyPem.value = ''
    sending.value = false
  }
}

async function setDefault(c: ProxyCertificateDto, value: boolean) {
  try {
    await $fetch(`/api/endpoints/${props.endpointId}/managed-proxy/certificates/${c.id}`, { method: 'PATCH', body: { isDefault: value } })
    await refresh()
    emit('changed')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}

async function remove(c: ProxyCertificateDto) {
  const ok = await confirm({ title: 'Supprimer le certificat', message: `${c.domains.join(', ')} — la clé chiffrée est détruite. Les domaines couverts repasseront sur ACME ou sur le certificat par défaut à la prochaine application.`, confirmLabel: 'Supprimer', danger: true })
  if (!ok) return
  try {
    await $fetch(`/api/endpoints/${props.endpointId}/managed-proxy/certificates/${c.id}`, { method: 'DELETE' })
    await refresh()
    emit('changed')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}

const STATE = { valid: { label: 'valide', tone: 'success' }, expiring: { label: 'expire bientôt', tone: 'warning' }, expired: { label: 'expiré', tone: 'danger' } } as const
const daysLeft = (iso: string) => Math.floor((new Date(iso).getTime() - Date.now()) / 864e5)
</script>

<template>
  <div class="certs">
    <div class="bar">
      <h3><FileKey :size="15" /> Certificats importés</h3>
      <UiButton v-if="canManage && !showForm" size="sm" @click="showForm = true"><Upload :size="13" /> Importer un certificat</UiButton>
    </div>
    <p v-if="intro" class="muted small">{{ intro }}</p>
    <p v-else class="muted small">Pour des domaines sans ACME (certificat d'entreprise, autorité interne, joker). Un certificat importé est servi en priorité pour les domaines qu'il couvre ; ACME reste utilisé pour les autres.</p>

    <ul v-if="lastWarnings.length" class="warns small">
      <li v-for="(w, i) in lastWarnings" :key="i"><TriangleAlert :size="12" /> {{ w }}</li>
    </ul>

    <table v-if="certs?.length" class="tbl">
      <thead><tr><th>Domaines</th><th>Émetteur</th><th>Expiration</th><th>Couvre</th><th>Par défaut</th><th /></tr></thead>
      <tbody>
        <tr v-for="c in certs" :key="c.id">
          <td>
            <span v-for="d in c.domains" :key="d" class="chip mono">{{ d }}</span>
            <UiBadge v-if="tracksApply && c.pendingApply" tone="warning">à appliquer</UiBadge>
            <UiBadge v-if="c.source === 'acme'" tone="info">Let's Encrypt</UiBadge>
          </td>
          <td class="small">{{ c.issuer }} <UiBadge v-if="c.selfSigned" tone="warning">auto-signé</UiBadge><div class="muted">{{ c.keyType }}</div></td>
          <td class="small"><UiBadge :tone="STATE[c.state].tone" dot>{{ STATE[c.state].label }}</UiBadge><div class="muted">{{ fmtDate(c.notAfter) }} ({{ daysLeft(c.notAfter) }} j)</div></td>
          <td class="small">{{ c.covers.join(', ') || '—' }}</td>
          <td><UiSwitch :model-value="c.isDefault" :disabled="!canManage" :aria-label="`Certificat par défaut : ${c.domains[0]}`" @update:model-value="v => setDefault(c, v)" /></td>
          <td><UiButton v-if="canManage" size="sm" variant="ghost" :aria-label="`Supprimer ${c.domains[0]}`" @click="remove(c)"><Trash2 :size="14" /></UiButton></td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="certs" class="muted small">Aucun certificat importé.</p>

    <form v-if="showForm" class="form card" autocomplete="off" @submit.prevent="submit">
      <UiField label="Certificat (PEM, avec la chaîne : serveur puis intermédiaires)" for="pc-cert" :error="errors.certPem">
        <textarea id="pc-cert" v-model="certPem" class="input mono" rows="5" spellcheck="false" placeholder="-----BEGIN CERTIFICATE-----" />
        <label class="file small"><input type="file" accept=".pem,.crt,.cer,.txt" @change="e => readFile(e, 'cert')"> Choisir un fichier…</label>
      </UiField>
      <UiField label="Clé privée (PEM, non chiffrée)" for="pc-key" :error="errors.keyPem" hint="Chiffrée par la plateforme, jamais réaffichée ni écrite dans le Compose ; transmise à Traefik au déploiement.">
        <textarea id="pc-key" v-model="keyPem" class="input mono secret" rows="4" spellcheck="false" placeholder="-----BEGIN PRIVATE KEY-----" />
        <label class="file small"><input type="file" accept=".pem,.key,.txt" @change="e => readFile(e, 'key')"> Choisir un fichier…</label>
      </UiField>
      <label class="small check"><input v-model="isDefault" type="checkbox"> Certificat par défaut (servi pour les noms qu'aucun certificat ne couvre)</label>
      <div class="actions">
        <UiButton type="button" variant="ghost" @click="showForm = false; keyPem = ''">Annuler</UiButton>
        <UiButton type="submit" variant="primary" :loading="sending" :disabled="certPem.length < 50 || keyPem.length < 50">Contrôler et importer</UiButton>
      </div>
    </form>
  </div>
</template>

<style scoped>
.certs { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--border); }
.bar { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); }
h3 { margin: 0; font-size: 14px; display: flex; gap: 6px; align-items: center; }
.small { font-size: 12.5px; }
p { margin: 0; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; font-weight: 500; font-size: 12px; color: var(--text-muted); padding: 5px 8px 5px 0; border-bottom: 1px solid var(--border); }
.tbl td { padding: 7px 8px 7px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
.chip { display: inline-block; font-size: 11.5px; padding: 1px 7px; margin: 0 4px 3px 0; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); }
.warns { margin: 0; padding: 0; list-style: none; color: var(--warning); display: flex; flex-direction: column; gap: 3px; }
.form { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3) var(--space-4); box-shadow: none; }
.form textarea { width: 100%; resize: vertical; font-size: 11.5px; }
.secret { -webkit-text-security: disc; }
.file { display: inline-flex; gap: 6px; margin-top: 4px; color: var(--primary); cursor: pointer; }
.file input { font-size: 12px; }
.check { display: flex; gap: 6px; align-items: center; }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
