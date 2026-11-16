# Spikes techniques (§23)

Statut : hypothèses de travail issues de l'étude de l'API Portainer v2. **Elles restent à valider sur les versions réellement déployées** (spike 8).

**Mise à jour Sprint 3** : spike 2 tranché. Le build est réalisé **par le Runner** sur l'hôte (moteur Docker local, contexte déjà présent sur place, aucun transfert supplémentaire), et non par le proxy Docker de Portainer. Spikes 5 et 6 traités : contexte borné en taille, logs en flux NDJSON. Spike 10 traité : rétention des répertoires et des images. Spike 8 partiellement validé : adaptateur HTTP et déploiement testés contre Portainer CE 2.27.4.

**Mise à jour Sprint 2** : spikes 1, 3 et 4 tranchés. Le Target Runner est implémenté (répertoire de travail persistant §6). L'authentification est faite en mTLS + HMAC, comme proposé ci-dessous, et testée en intégration (certificat d'une autre AC, rejeu, corps altéré : tous refusés).

## 1–3. Dépôt de fichiers, build et nécessité du Target Runner

**Ce que Portainer v2 couvre :**
- Il relaie l'API Docker de chaque environnement : `/api/endpoints/{id}/docker/*`. Un `POST .../docker/build` accepte un contexte tar dans le corps de la requête. Le build peut donc se faire **sur l'hôte cible sans Runner**, avec un contexte construit côté backend et des logs de build reçus en flux.
- Il crée des stacks Compose depuis une chaîne (`/api/stacks/create/standalone/string`), un fichier, ou **directement depuis un dépôt Git** (`/api/stacks/create/standalone/repository`).

**Ce que Portainer ne couvre pas :**
- Écrire, lire ou lister des fichiers dans un répertoire de l'hôte (§6 : `releases/`, `current`, `shared/`).
- Le seul contournement passe par un conteneur éphémère avec un bind mount du répertoire. Cela revient à un shell root sur l'hôte et contredit §4. **Écarté.**

**Recommandation :**
- Build : passer par le proxy Docker de Portainer (pas de Runner nécessaire). Il faut quand même mesurer les limites de taille de contexte et de timeout derrière Portainer et l'agent (spike 5).
- Répertoire de travail persistant sur l'hôte : **Target Runner obligatoire**. À trancher avec le métier : si la conservation des releases côté plateforme (PostgreSQL + stockage objet) suffit, le Runner devient optionnel et le périmètre du MVP se réduit nettement.

## 4. Authentification Nuxt ↔ Runner

Proposition :
- mTLS avec une CA interne dédiée et un certificat client par instance de plateforme ;
- requêtes signées HMAC-SHA256 sur méthode, chemin, horodatage, nonce et hash du corps ; fenêtre de ±60 s ; nonces conservés 5 min ;
- le Runner n'accepte que les actions de `runnerActions` et revalide tout chemin après `realpath`, contre ses racines déclarées localement (jamais seulement celles envoyées par la plateforme) ;
- audit local côté Runner, remonté à la plateforme.

## 5. Contextes de build volumineux

À mesurer : la limite de taille de corps du proxy Portainer et le timeout de l'agent. Pistes : `.dockerignore` imposé, compression gzip, plafond `maxProjectSizeMb` par serveur. Au-delà, build via le Runner à partir du contexte déjà présent sur l'hôte.

## 6. Logs de build

Le build via le proxy Docker renvoie un flux JSON ligne par ligne (`{"stream": ...}`). On le parse dans le worker, on le masque (Redactor), on l'insère dans `deployment_logs` et on le diffuse en SSE via Redis pub/sub.

## 7. Détection des mises à jour Watchtower

Options : notifications Watchtower vers un webhook (shoutrrr `generic+https`) exposé par la plateforme, ou comparaison périodique des digests d'images des conteneurs. Préférer le webhook, avec la comparaison de digests en rattrapage.

## 9. Registries privés

Portainer stocke les registries (`/api/registries`). Pour le build, transmettre `X-Registry-Config`. Pour les stacks, Portainer applique ses propres identifiants de registry. Vérifier l'accès des tokens API aux registries selon le rôle de l'utilisateur Portainer associé.

## 10. Nettoyage

Releases : conserver les `releasesToKeep` dernières par cible. Images : `docker image prune` filtré par label `platform.release` via le proxy. Fichiers temporaires : action Runner `cleanup` à la fin de chaque job et via une purge planifiée.
