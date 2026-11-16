<script setup lang="ts">
/**
 * Assistant d'initialisation (premier démarrage) : vérifications, accès, SSO,
 * notifications, serveurs, GitHub. Chaque étape facultative peut être passée ;
 * l'assistant peut être repris plus tard (page Mise en service).
 */
import { ONBOARDING_STEPS, type OnboardingFacts, type OnboardingState, type OnboardingStep, STEP_LABEL } from '#shared/schemas/onboarding'

useHead({ title: 'Initialisation' })
const route = useRoute()
const router = useRouter()
const toast = useToast()
const { refresh: refreshMe } = useAuth()

const { data, refresh } = await useFetch<{ state: OnboardingState, facts: OnboardingFacts }>('/api/onboarding')
const OPTIONAL: OnboardingStep[] = ['sso', 'notifications', 'servers', 'github']

const steps = ONBOARDING_STEPS.map(key => ({ key, label: STEP_LABEL[key] }))
const indexOf = (k: unknown) => Math.max(0, ONBOARDING_STEPS.indexOf((k as OnboardingStep) ?? 'checks'))
const current = ref(indexOf(route.query.step))
const reached = computed(() => {
  const visited = ONBOARDING_STEPS.map((s, i) => (data.value?.state.steps[s] ? i + 1 : 0))
  return Math.max(current.value, ...visited)
})
const step = computed(() => ONBOARDING_STEPS[current.value]!)
watch(current, i => void router.replace({ query: { step: ONBOARDING_STEPS[i] } }))
watch(() => route.query.step, (s) => { if (s && indexOf(s) !== current.value) current.value = indexOf(s) })

const busy = ref(false)
async function mark(status: 'done' | 'skipped') {
  busy.value = true
  try {
    await $fetch<OnboardingState>(`/api/onboarding/steps/${step.value}`, { method: 'PUT', body: { status } })
    await refresh()
    current.value = Math.min(current.value + 1, ONBOARDING_STEPS.length - 1)
    window.scrollTo({ top: 0 })
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = false
  }
}
async function finish(mode: 'completed' | 'dismissed') {
  busy.value = true
  try {
    await $fetch<OnboardingState>('/api/onboarding/finish', { method: 'POST', body: { mode } })
    await refreshMe()
    if (mode === 'completed') {
      toast.success('Initialisation terminée')
      await navigateTo('/admin/readiness')
    }
    else {
      toast.info('Assistant reporté : il reste accessible depuis Administration → Mise en service')
      await navigateTo('/')
    }
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="data" class="wizard">
    <UiPageHeader title="Initialisation de la plateforme" icon="sparkles">
      <UiButton v-if="data.state.status !== 'completed'" variant="ghost" :disabled="busy" @click="finish('dismissed')">Reprendre plus tard</UiButton>
    </UiPageHeader>

    <UiStepper :steps="steps" :current="current" :reached="reached" @go="i => current = i" />

    <section class="card pad">
      <header class="head">
        <h2>{{ STEP_LABEL[step] }}</h2>
        <UiBadge v-if="data.state.steps[step]" :tone="data.state.steps[step] === 'done' ? 'success' : 'warning'">{{ data.state.steps[step] === 'done' ? 'fait' : 'passé' }}</UiBadge>
        <UiBadge v-if="OPTIONAL.includes(step)" tone="neutral">facultatif</UiBadge>
      </header>

      <StepChecks v-if="step === 'checks'" :facts="data.facts" />
      <StepAccess v-else-if="step === 'access'" :facts="data.facts" @changed="refresh()" />
      <StepSso v-else-if="step === 'sso'" :facts="data.facts" @changed="refresh()" />
      <StepNotifications v-else-if="step === 'notifications'" :facts="data.facts" @changed="refresh()" />
      <StepServers v-else-if="step === 'servers'" :facts="data.facts" />
      <StepGithub v-else-if="step === 'github'" :facts="data.facts" />
      <StepDone v-else :facts="data.facts" :state="data.state" />

      <footer class="foot">
        <UiButton v-if="current > 0" variant="ghost" :disabled="busy" @click="current--">Précédent</UiButton>
        <span class="spacer" />
        <template v-if="step !== 'done'">
          <UiButton v-if="OPTIONAL.includes(step)" :disabled="busy" @click="mark('skipped')">Passer cette étape</UiButton>
          <UiButton variant="primary" :loading="busy" @click="mark('done')">Continuer</UiButton>
        </template>
        <UiButton v-else variant="primary" :loading="busy" @click="finish('completed')">Terminer l'initialisation</UiButton>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.wizard { max-width: 980px; }
.sub { margin: 4px 0 0; }
.pad { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-4); }
.head { display: flex; gap: var(--space-2); align-items: center; }
.head h2 { margin: 0; }
.desc { margin: 0; }
.foot { display: flex; gap: var(--space-2); align-items: center; border-top: 1px solid var(--border); padding-top: var(--space-4); margin-top: var(--space-2); }
.spacer { flex: 1; }
</style>
