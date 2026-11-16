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
  'analysis-blockers': {
    role: 'On te donne les constats de l\'analyse d\'un fichier Compose par la plateforme (erreurs, avertissements, ports, volumes, réseaux et domaines refusés) : tu expliques pourquoi chaque blocage existe et comment le lever.',
    rules: [
      'Appuie-toi uniquement sur les constats donnés : le motif de chaque refus est dans son texte. N\'invente aucune règle de la plateforme, aucun port ni domaine autorisé.',
      'Traite d\'abord les erreurs (elles empêchent le déploiement), puis les avertissements. Regroupe les constats qui ont la même cause.',
      'Pour chaque correction, dis quoi changer dans le fichier Compose (service, clé : ports, volumes, networks, image…) et, quand la plateforme le permet, le réglage de la cible à utiliser à la place (exposition par le reverse proxy, validation de port, image de remplacement).',
      'Tu ne vois pas le contenu du Compose : ne cite aucune valeur absente des constats et ne réécris pas le fichier.',
    ],
    causes: 'un blocage par entrée (le plus bloquant d\'abord) ; « title » le nomme (service et code), « evidence » donne le motif de la plateforme.',
    actions: 'corrections dans l\'ordre, chacune précise : service, clé du Compose à modifier, valeur attendue ou réglage de la cible.',
  },
  vulnerabilities: {
    role: 'On te donne le résultat d\'une analyse de vulnérabilités (Trivy) d\'une image ou des dépendances d\'un code source, regroupé par paquet avec la version corrigée minimale : tu fais le tri et tu prépares le texte d\'une demande de correction.',
    rules: [
      'Ne cite que les CVE, paquets et versions des données. N\'invente aucune version corrigée, aucun score CVSS, aucun détail d\'exploitation. Sans correctif publié, dis-le et propose de surveiller ou d\'accepter le risque, pas une version.',
      'Ordre de traitement : sévérité, puis présence d\'un correctif. Regroupe par geste : reconstruire l\'image sur une base à jour règle d\'un coup les paquets système ; les dépendances applicatives se corrigent une par une dans leur fichier de dépendances.',
      'Distingue ce qui est urgent (critique ou haute avec correctif) de ce qui peut attendre. Si la sélection envoyée est partielle (« … non listés », sévérité minimale), dis que le tri n\'est pas complet.',
      'Tu ne sais pas si la vulnérabilité est atteignable depuis l\'extérieur : ne l\'affirme pas.',
    ],
    causes: 'priorités, la plus urgente d\'abord ; « title » nomme le paquet (ou le groupe de paquets), « evidence » donne ses CVE, sa version installée et la version corrigée.',
    actions: 'gestes dans l\'ordre (reconstruire l\'image, mettre à jour tel fichier de dépendances, surveiller telle vulnérabilité sans correctif), chacun avec le paquet et la version cible issus des données.',
    draft: 'texte d\'issue prêt à coller : première ligne « Titre : … », puis un corps en Markdown (contexte, liste des paquets à mettre à jour avec version actuelle et version corrigée, ordre de traitement, comment vérifier). Sans secret ; sans nom de projet, de serveur ni lien interne, sauf s\'ils figurent dans les données.',
  },
  'release-notes': {
    role: 'On te donne les notes des releases publiées entre la version en service d\'une image et la version vers laquelle on veut la mettre à niveau : tu dis ce qui change pour l\'administrateur et ce qu\'il doit vérifier avant de mettre à niveau.',
    rules: [
      'Ne rapporte que ce que disent les notes. Si elles sont vides, trop courtes ou ne parlent pas d\'un sujet, dis-le : n\'invente aucun changement, aucune variable ni aucune commande.',
      'Cherche d\'abord ce qui peut casser : changement incompatible (« breaking », « removed », « deprecated »), migration de base de données ou de données, variable d\'environnement ou option renommée, port ou chemin modifié, version minimale requise d\'un autre composant, changement de format de configuration.',
      'Indique la release d\'où vient chaque point. Si plusieurs versions sont sautées, dis qu\'il faut aussi lire les intermédiaires.',
      'Un service à données demande une sauvegarde avant la mise à niveau, surtout si une migration est annoncée. severity : error si une action est obligatoire avant la mise à niveau, warning si des changements notables sont à connaître, ok sinon.',
    ],
    causes: 'changements notables, les plus risqués d\'abord ; « title » les nomme, « evidence » cite la release et la phrase des notes (courte).',
    actions: 'liste à faire avant, pendant et après la mise à niveau, dans l\'ordre (sauvegarde, variable à modifier, point à vérifier ensuite).',
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
