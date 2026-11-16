/**
 * Consignes des fonctions d'assistance (données pures, testées) : rôle du modèle, règles propres et
 * sens des champs de la réponse. Les règles communes (données non fiables, français, JSON, pas
 * d'invention) sont dans `prompt.ts`.
 */
import type { OllamaFeature } from '../../../shared/schemas/ollama'
import type { TaskSpec } from './prompt'

export const TASKS: Partial<Record<OllamaFeature, TaskSpec>> = {
  logs: {
    role: 'On te donne un extrait de logs (déploiement ou conteneur) et tu l\'analyses pour un administrateur.',
    rules: [
      'Cherche d\'abord la cause de l\'arrêt ou de l\'échec : première erreur de la chaîne, pas ses conséquences.',
    ],
    causes: 'de la plus vraisemblable à la moins vraisemblable ; « evidence » cite la ligne ou le fait des logs qui l\'appuie.',
    actions: 'étapes concrètes et vérifiables, dans l\'ordre (commande, fichier, réglage).',
  },
  'deploy-failure': {
    role: 'On te donne le contexte d\'un déploiement qui a échoué (faits, dernier message de chaque étape, état réel de la stack sur l\'hôte, journal) : tu en déduis pourquoi il a échoué.',
    rules: [
      'Les statuts se suivent : VALIDATING (contrôles), PREPARING_FILES (fichiers sur l\'hôte), BUILDING (build des images), DEPLOYING (stack lancée), HEALTH_CHECKING (santé des services). « Échec depuis le statut » dit où il s\'est arrêté.',
      'Distingue la cause (première erreur de la chaîne) de ses conséquences. Si l\'état réel de la stack contredit le journal (services en marche malgré l\'échec, ou l\'inverse), signale-le.',
      'Privilégie les actions faisables depuis la plateforme (relancer le déploiement, corriger une variable ou une exposition, lire les logs d\'un service) avant les commandes sur l\'hôte.',
    ],
    causes: 'causes probables, la plus vraisemblable d\'abord ; « evidence » cite la ligne du journal ou le fait qui l\'appuie.',
    actions: 'étapes dans l\'ordre, la première étant vérifiable sans rien casser.',
  },
  support: {
    role: 'On te donne le rapport « tech support » d\'une cible (identité, diagnostic, conteneurs, réseau, configuration, déploiements récents, journaux) : tu en fais la synthèse pour un ticket de support.',
    rules: [
      'summary : le symptôme principal en deux ou trois phrases, puis l\'état actuel.',
      'Ne reprends pas la configuration sans rapport avec le problème. Si le rapport ne montre aucun problème, dis-le.',
    ],
    causes: 'hypothèses classées de la plus à la moins vraisemblable ; « evidence » cite la section du rapport et le fait qui l\'appuie.',
    actions: 'ordre de vérification, du moins coûteux au plus coûteux.',
    draft: 'texte de ticket prêt à coller, en 15 lignes au plus : symptôme, contexte (projet, environnement, serveur), constats, hypothèses, ce qui reste à vérifier. Sans secret.',
  },
  metrics: {
    role: 'On te donne l\'historique des ressources d\'un conteneur (synthèse chiffrée, relevés, alertes) et les déploiements de la période : tu dis ce qu\'il montre.',
    rules: [
      'CPU : 100 % = un cœur. Mémoire : % de la limite du conteneur (en Mio si sans limite). Redémarrages : compteur cumulé, qui ne baisse que si le conteneur est recréé.',
      'Distingue : fuite mémoire (hausse continue sans palier), saturation CPU (plateau haut), boucle de plantage (redémarrages en hausse), charge normale.',
      'Ne relie une dérive à un déploiement que si leur écart de temps le permet ; sinon dis que rien ne permet de les relier. Si la période est courte, dis que la conclusion est limitée.',
    ],
    causes: 'constats chiffrés (ex. « mémoire de 40 % à 88 % en 6 h ») ; « evidence » donne les valeurs ou les heures.',
    actions: 'vérifications ou réglages (limite mémoire, redémarrage, lecture des logs à telle heure), dans l\'ordre.',
  },
  proxy: {
    role: 'On te donne la carte des reverse proxies d\'un hôte (proxies, routes, certificats, erreurs ACME, ports publiés hors proxy) : tu expliques ce qui est servi et ce qui ne va pas.',
    rules: [
      'Cherche : route sans conteneur ou sur un mauvais port, certificat expiré ou en erreur, redirection HTTPS absente, domaine servi deux fois, port publié directement sur l\'hôte sans passer par le proxy.',
      'Si une question est posée (un domaine, une route), réponds d\'abord à elle à partir des routes listées.',
    ],
    causes: 'anomalies ou points notables, chacun avec le domaine ou la route concernés dans « evidence ».',
    actions: 'corrections dans l\'ordre (exposition du projet, réseau à rejoindre, renouvellement ACME…).',
  },
}

export function taskFor(feature: OllamaFeature): TaskSpec {
  const t = TASKS[feature]
  if (!t) throw new Error(`Consigne manquante pour la fonction ${feature}`)
  return t
}
