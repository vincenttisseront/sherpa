<script setup lang="ts">
/** Étape 3 : fournisseur SSO (Keycloak, Okta, OIDC), test de découverte, groupes. */
import type { OnboardingFacts } from '#shared/schemas/onboarding'

const props = defineProps<{ facts: OnboardingFacts }>()
const emit = defineEmits<{ changed: [] }>()
const toast = useToast()

const PRESETS = {
  keycloak: { label: 'Keycloak', issuer: 'https://keycloak.example.com/realms/mon-realm', scopes: ['openid', 'profile', 'email'], help: 'Client confidentiel, « Standard flow » activé. Ajouter un mapper « Group Membership » (claim groups) : les groupes arrivent sous la forme /nom.' },
  okta: { label: 'Okta', issuer: 'https://mon-org.okta.com/oauth2/default', scopes: ['openid', 'profile', 'email', 'groups'], help: 'Application Web, « Authorization Code ». Ajouter au serveur d\'autorisation un claim « groups » filtré sur les groupes concernés.' },
  oidc: { label: 'OIDC générique', issuer: 'https://idp.example.com', scopes: ['openid', 'profile', 'email'], help: 'Tout fournisseur OpenID Connect avec découverte (.well-known/openid-configuration).' },
} as const
type Kind = keyof typeof PRESETS

const kind = ref<Kind | null>(null)
const form = reactive({ key: '', name: '', issuerUrl: '', clientId: 'sherpa', clientSecret: '', domains: '' })
const errors = ref<Record<string, string>>({})
const saving = ref(false)
const created = ref<{ id: string, key: string } | null>(null)
const test = ref<{ ok: boolean, error?: string, issuer?: string, pkce?: boolean, endSession?: boolean } | null>(null)
const mappings = ref<{ externalGroup: string, groupId: string }[]>([])

function choose(k: Kind) {
  kind.value = k
  const used = new Set(props.facts.idps.map(i => i.key))
  let key: string = k
  for (let n = 2; used.has(key); n++) key = `${k}-${n}`
  Object.assign(form, { key, name: PRESETS[k].label, issuerUrl: '', clientId: 'sherpa', clientSecret: '', domains: '' })
  created.value = null
  test.value = null
  mappings.value = props.facts.groups.map(g => ({ externalGroup: '', groupId: g.id }))
}
const redirectUri = computed(() => `${props.facts.appUrl}/api/auth/oidc/${form.key || '<clé>'}/callback`)

async function save() {
  if (!kind.value) return
  saving.value = true
  errors.value = {}
  try {
    const r = await $fetch<{ id: string }>('/api/admin/idps', {
      method: 'POST',
      body: {
        key: form.key, kind: kind.value, name: form.name, issuerUrl: form.issuerUrl, clientId: form.clientId,
        ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
        scopes: [...PRESETS[kind.value].scopes], groupsClaim: 'groups', requireMappedGroup: true,
        allowedEmailDomains: form.domains.split(/[\s,;]+/).filter(Boolean), enabled: true,
      },
    })
    form.clientSecret = ''
    created.value = { id: r.id, key: form.key }
    emit('changed')
    await runTest()
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    toast.error(e.message)
  }
  finally {
    saving.value = false
  }
}
async function runTest() {
  if (!created.value) return
  test.value = await $fetch<NonNullable<typeof test.value>>(`/api/admin/idps/${created.value.id}/test`, { method: 'POST' })
}
async function saveMappings() {
  try {
    await $fetch<unknown>(`/api/admin/idps/${created.value!.id}/mappings`, { method: 'PUT', body: mappings.value.filter(m => m.externalGroup.trim() && m.groupId) })
    toast.success('Correspondance des groupes enregistrée')
    emit('changed')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast.info('Copié'), () => toast.error('Copie impossible'))
</script>

<template>
  <div class="step">
    <div v-if="facts.idps.length" class="existing">
      <strong class="small">Déjà configurés :</strong>
      <span v-for="i in facts.idps" :key="i.id" class="small"><UiBadge :tone="i.enabled ? 'success' : 'neutral'">{{ i.name }}</UiBadge> {{ i.mappings }} groupe(s) mappé(s)</span>
      <NuxtLink to="/admin/sso" class="small">Gérer</NuxtLink>
    </div>
    <div class="kinds" role="group" aria-label="Fournisseur">
      <UiButton v-for="(p, k) in PRESETS" :key="k" :variant="kind === k ? 'primary' : 'secondary'" @click="choose(k)">{{ p.label }}</UiButton>
    </div>

    <template v-if="kind">
      <p class="muted small">{{ PRESETS[kind].help }}</p>
      <div class="redirect">
        <span class="small">URI de redirection à déclarer chez le fournisseur :</span>
        <code>{{ redirectUri }}</code>
        <UiButton size="sm" variant="ghost" @click="copy(redirectUri)">Copier</UiButton>
      </div>
      <form v-if="!created" class="grid" @submit.prevent="save">
        <UiField label="Nom affiché" for="i-name" :error="errors.name"><input id="i-name" v-model.trim="form.name" class="input" required></UiField>
        <UiField label="Clé (dans l'URI)" for="i-key" :error="errors.key" hint="minuscules, chiffres, tirets"><input id="i-key" v-model.trim="form.key" class="input mono" required></UiField>
        <UiField class="span" label="Émetteur (issuer)" for="i-issuer" :error="errors.issuerUrl"><input id="i-issuer" v-model.trim="form.issuerUrl" class="input mono" type="url" :placeholder="PRESETS[kind].issuer" required></UiField>
        <UiField label="Client ID" for="i-client" :error="errors.clientId"><input id="i-client" v-model.trim="form.clientId" class="input mono" required></UiField>
        <UiField label="Client secret" for="i-secret" :error="errors.clientSecret" hint="Chiffré, jamais réaffiché"><input id="i-secret" v-model="form.clientSecret" class="input mono" type="password" autocomplete="off"></UiField>
        <UiField class="span" label="Domaines d'email autorisés (facultatif)" for="i-domains" hint="Ex. : exemple.fr — vide : tous"><input id="i-domains" v-model="form.domains" class="input"></UiField>
        <div class="span"><UiButton type="submit" variant="primary" :loading="saving">Enregistrer et tester</UiButton></div>
      </form>

      <div v-else class="result">
        <p v-if="test?.ok" class="ok small">Découverte OIDC réussie : {{ test.issuer }} · PKCE {{ test.pkce ? 'supporté' : 'non annoncé' }} · déconnexion {{ test.endSession ? 'supportée' : 'non annoncée' }}.</p>
        <p v-else-if="test" class="ko small">Découverte en échec : {{ test.error }}. Vérifier l'émetteur et l'accès réseau de la plateforme vers le fournisseur.</p>
        <UiButton size="sm" variant="ghost" @click="runTest">Retester</UiButton>

        <h3>Groupes du fournisseur → groupes de la plateforme</h3>
        <p class="muted small">Nom exact du groupe tel que transmis dans la revendication « groups »{{ kind === 'keycloak' ? ' (ex. /devops)' : '' }}. Sans groupe mappé, l'accès est refusé.</p>
        <p v-if="!facts.groups.length" class="muted small">Créer d'abord les groupes à l'étape « Accès ».</p>
        <div v-for="(m, i) in mappings" :key="i" class="map">
          <input v-model.trim="m.externalGroup" class="input mono" :aria-label="`Groupe du fournisseur pour ${facts.groups.find(g => g.id === m.groupId)?.name}`" :placeholder="kind === 'keycloak' ? '/nom-du-groupe' : 'nom-du-groupe'">
          <span>→</span>
          <span>{{ facts.groups.find(g => g.id === m.groupId)?.name }}</span>
        </div>
        <UiButton v-if="mappings.length" size="sm" variant="primary" @click="saveMappings">Enregistrer la correspondance</UiButton>
        <p class="muted small">Pour valider : se déconnecter puis se connecter avec « Se connecter avec {{ form.name }} ». La page Mise en service affichera la date de la première connexion.</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.step { display: flex; flex-direction: column; gap: var(--space-3); }
.lead { margin: 0; }
.small { font-size: 12.5px; margin: 0; }
.existing { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
.kinds { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.redirect { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; padding: var(--space-2) var(--space-3); background: var(--surface-2); border-radius: var(--radius); }
.redirect code { overflow-wrap: anywhere; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-3); }
.span { grid-column: 1 / -1; }
.result { display: flex; flex-direction: column; gap: var(--space-2); }
.result h3 { margin: var(--space-3) 0 0; font-size: 15px; }
.ok { color: var(--success); }
.ko { color: var(--danger); }
.map { display: grid; grid-template-columns: minmax(180px, 1fr) auto 1fr; gap: var(--space-2); align-items: center; }
</style>
