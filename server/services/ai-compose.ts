/**
 * « docker run » → Compose par Ollama. Le modèle ne reçoit qu'une commande normalisée dont les valeurs
 * de variables sensibles sont remplacées par `${NOM}` ; son Compose est comparé à la commande (rien
 * d'ajouté, rien d'oublié), puis revalidé par l'analyse Compose de la cible (ports, volumes, réseaux,
 * droits). Il est seulement proposé : rien n'est enregistré ni déployé.
 */
import { createError } from 'h3'
import type { ComposeGenDto } from '../../shared/schemas/ollama'
import { canonicalCommand, checkFidelity, composeGenFormat, composeGenMessages, DockerRunError, parseComposeOutput, parseDockerRun, planEnv } from '../lib/ollama/compose-gen'
import { type Progress, noProgress } from '../utils/progress'
import { callModel, cleaner, requireFeature } from './ai-task'
import { analyzeForTarget, type TargetRow, targetVariables } from './projects'

const COMPOSE_FILE = 'docker-compose.yml'
const MAX_ISSUES = 60

export async function composeFromDockerRun(t: TargetRow, command: string, progress: Progress = noProgress): Promise<ComposeGenDto> {
  const ctx = await requireFeature('compose-gen')
  let run
  try {
    run = parseDockerRun(command)
  }
  catch (err) {
    if (err instanceof DockerRunError) throw createError({ statusCode: 422, statusMessage: err.message })
    throw err
  }
  const clean = cleaner()
  const lines = canonicalCommand(run, clean)
  const plan = planEnv(run).filter(e => e.placeholder)

  await progress.step('Lecture de la commande', 1, 3)
  await progress.step('Rédaction du Compose par le modèle Ollama (peut prendre une minute)', 2, 3)
  const res = await callModel('compose-gen', { messages: composeGenMessages(lines), format: composeGenFormat, numPredict: 1500 }, ctx)
  const meta: ComposeGenDto['meta'] = { model: res.model, at: new Date().toISOString(), durationMs: res.durationMs, totalLines: lines.length, sentLines: lines.length, truncated: false }

  const parsed = parseComposeOutput(res.content)
  if (!parsed) {
    return { compose: null, notes: ['Le modèle n\'a pas produit de Compose exploitable : réessayer, ou essayer un modèle plus grand.'], variables: [], fidelity: [], analysis: null, structured: false, meta }
  }

  await progress.step('Contrôle du Compose et analyse de la cible', 3, 3)
  // Pas de masquage du Compose : il ne contient que ce qui a été envoyé (déjà masqué) et les motifs de
  // masquage détruiraient les références ${NOM} ; c'est la comparaison à la commande qui le garde.
  const fidelity = checkFidelity(run, parsed.compose)
  const existing = await targetVariables(t.target)
  const variables = plan.map(e => ({ name: e.name, known: !!existing[e.name] }))

  let analysis: ComposeGenDto['analysis'] = null
  try {
    // Valeurs fictives pour les variables que la cible n'a pas encore : l'analyse juge le fichier, pas la saisie.
    const stand = Object.fromEntries(variables.filter(v => !v.known).map(v => [v.name, { value: 'x', secret: true }]))
    const result = await analyzeForTarget(t, {
      composeText: parsed.compose,
      composePath: COMPOSE_FILE,
      files: new Set([COMPOSE_FILE]),
      releaseSlug: 'apercu',
      portApprovals: [],
      variables: { ...existing, ...stand },
    }, { persist: false })
    analysis = { ok: result.ok && !fidelity.length, issues: result.issues.slice(0, MAX_ISSUES) }
  }
  catch (err) {
    console.error('[ollama] analyse du Compose généré impossible', err)
  }
  return { compose: parsed.compose, notes: parsed.notes.map(clean), variables, fidelity, analysis, structured: true, meta }
}
