/**
 * Analyse des logs d'un conteneur : signatures d'erreurs connues → cause probable et quoi faire.
 * Fonction pure, partagée par la vue en direct (navigateur) et le diagnostic (serveur). Les lignes
 * reçues sont déjà masquées (secrets) ; une constatation ne cite qu'une ligne d'exemple.
 */

export type InsightSeverity = 'error' | 'warning' | 'info'

export interface LogInsight {
  id: string
  severity: InsightSeverity
  title: string
  /** Ce que la signature veut dire. */
  explain: string
  /** Quoi faire, dans la console de préférence. */
  fix: string
  count: number
  /** Dernière ligne concernée (exemple) et son rang dans les lignes analysées. */
  sample: string
  lastIndex: number
}

interface Rule {
  id: string
  re: RegExp
  severity: InsightSeverity
  title: string
  explain: string
  fix: string
  /** Règles plus génériques masquées quand celle-ci est trouvée (même cause). */
  hides?: string[]
}

const EXPLORER = 'Onglet Conteneurs → icône dossier du service (explorateur de fichiers)'

const RULES: Rule[] = [
  {
    id: 'libtorrent-state',
    re: /invalid type requested from entry|bdecode|libtorrent.*(corrupt|parse)|fastresume.*(invalid|corrupt|error)/i,
    severity: 'error',
    title: 'Fichier d\'état libtorrent corrompu',
    explain: 'Au démarrage, libtorrent (Deluge, qBittorrent) relit un fichier d\'état « bencodé » tronqué ou corrompu (arrêt brutal, disque plein) et s\'arrête.',
    fix: `Service arrêté, ${EXPLORER} : Deluge → /config/state, remplacer session.state et torrents.fastresume par leurs copies .bak (renommer l'actuel en .corrompu), sinon retirer torrents.fastresume (torrents revérifiés au démarrage) ; qBittorrent → BT_backup, retirer les .fastresume récents. Puis relancer.`,
    hides: ['cpp-terminate'],
  },
  {
    id: 'cpp-terminate',
    re: /terminate called after throwing an instance of/i,
    severity: 'error',
    title: 'Exception C++ non gérée',
    explain: 'Le programme (C++) a rencontré une erreur qu\'il ne gère pas et s\'est arrêté net. La ligne « what(): » qui suit en donne la raison ; souvent un fichier de données ou de configuration illisible.',
    fix: `Lire la ligne « what(): ». Si elle évoque un fichier, l'ouvrir ou le restaurer depuis sa sauvegarde (${EXPLORER}).`,
  },
  {
    id: 'sqlite-corrupt',
    re: /database disk image is malformed|SQLITE_CORRUPT|file is not a database/i,
    severity: 'error',
    title: 'Base SQLite corrompue',
    explain: 'La base SQLite du service est endommagée (arrêt brutal pendant une écriture, disque plein, stockage réseau).',
    fix: `Service arrêté, ${EXPLORER} : renommer la base (ex. *.db) et restaurer la dernière sauvegarde (les *arr la gardent dans /config/Backups) ; télécharger la base d'abord pour la conserver.`,
  },
  {
    id: 'sqlite-locked',
    re: /database is locked|SQLITE_BUSY/i,
    severity: 'warning',
    title: 'Base SQLite verrouillée',
    explain: 'Un autre processus écrit dans la base, ou elle est sur un partage réseau (NFS/SMB) qui gère mal les verrous.',
    fix: 'Vérifier qu\'un seul conteneur utilise ce dossier ; éviter les bases SQLite sur un partage réseau.',
  },
  {
    id: 'pg-version',
    re: /database files are incompatible with server|initialized by PostgreSQL version/i,
    severity: 'error',
    title: 'Données PostgreSQL d\'une autre version majeure',
    explain: 'L\'image PostgreSQL a changé de version majeure : les données sur disque ne sont pas lisibles par la nouvelle.',
    fix: 'Revenir à l\'image précédente (Mises à niveau → Revenir à la version du Compose), puis utiliser « Migrer les données vers … » de la fenêtre des mises à niveau.',
  },
  {
    id: 'pg-recovery',
    re: /was not properly shut down|automatic recovery in progress/i,
    severity: 'info',
    title: 'PostgreSQL en récupération après un arrêt brutal',
    explain: 'La base rejoue son journal : normal après un arrêt non propre, cela peut prendre du temps.',
    fix: 'Attendre la fin de la récupération ; si le healthcheck échoue entre-temps, allonger son start_period (Réglages → Healthchecks).',
  },
  {
    id: 'permission',
    re: /permission denied|EACCES|operation not permitted|EPERM\b/i,
    severity: 'error',
    title: 'Accès refusé à un fichier',
    explain: 'Le processus n\'a pas les droits sur un fichier ou un dossier monté : propriétaire différent de l\'utilisateur du conteneur (PUID/PGID des images LinuxServer, user: du Compose).',
    fix: `Comparer le propriétaire (uid:gid) affiché par l'explorateur de fichiers du service (onglet Conteneurs → icône dossier) avec PUID/PGID (onglet Variables) ; corriger sur l'hôte (chown) ou ajuster PUID/PGID puis Redéployer.`,
  },
  {
    id: 'readonly-fs',
    re: /read-only file system|EROFS/i,
    severity: 'error',
    title: 'Écriture sur un système de fichiers en lecture seule',
    explain: 'Le service écrit dans un montage déclaré en lecture seule (:ro), ou le disque de l\'hôte est passé en lecture seule (erreur disque).',
    fix: 'Vérifier le montage dans le Compose (retirer :ro si le service doit écrire) ; si tout l\'hôte est en lecture seule, vérifier son disque.',
  },
  {
    id: 'no-space',
    re: /no space left on device|ENOSPC|disk quota exceeded/i,
    severity: 'error',
    title: 'Disque plein',
    explain: 'Plus de place sur le disque (ou le quota) où le service écrit.',
    fix: 'Libérer de la place : fiche du serveur → Nettoyage (images, cache de build), anciens fichiers des services via l\'explorateur.',
  },
  {
    id: 'oom',
    re: /out of memory|cannot allocate memory|JavaScript heap out of memory|OutOfMemoryError|\bKilled$/i,
    severity: 'error',
    title: 'Mémoire insuffisante',
    explain: 'Le processus n\'a pas obtenu la mémoire demandée (limite du conteneur ou de l\'hôte).',
    fix: 'Augmenter la limite mémoire du service (mem_limit / deploy.resources) ou la mémoire de l\'hôte, puis Redéployer.',
  },
  {
    id: 'port-in-use',
    re: /address already in use|EADDRINUSE|bind: address/i,
    severity: 'error',
    title: 'Port déjà utilisé',
    explain: 'Le port que le service veut ouvrir est déjà pris (autre conteneur publiant le même port sur l\'hôte, ou deux processus dans le conteneur).',
    fix: 'Voir quel conteneur publie ce port (Conteneurs en direct) ; changer le port publié dans le Compose ou arrêter l\'autre service.',
  },
  {
    id: 'dns',
    re: /could not translate host name|name or service not known|getaddrinfo (ENOTFOUND|EAI_AGAIN)|no such host|temporary failure in name resolution|Name does not resolve/i,
    severity: 'error',
    title: 'Nom d\'hôte introuvable',
    explain: 'Le service cherche un autre service ou un serveur par son nom et ne le trouve pas : service absent ou arrêté, nom erroné dans les variables, réseau non partagé.',
    fix: 'Vérifier le nom dans les variables (onglet Variables) et que le service visé tourne ; « Export tech support » de la cible montre la résolution des noms vue par chaque conteneur.',
  },
  {
    id: 'conn-refused',
    re: /connection refused|ECONNREFUSED/i,
    severity: 'warning',
    title: 'Connexion refusée',
    explain: 'Le service visé est joignable mais n\'écoute pas sur ce port : pas encore démarré, arrêté, ou mauvais port.',
    fix: 'Vérifier que la dépendance tourne (et est saine) et le port dans les variables ; une dépendance lente au démarrage se règle avec depends_on: condition: service_healthy.',
  },
  {
    id: 'timeout',
    re: /(connection|connect|read|request) timed? ?out|ETIMEDOUT|context deadline exceeded/i,
    severity: 'warning',
    title: 'Délai dépassé',
    explain: 'Une connexion n\'a pas abouti à temps : service distant lent ou injoignable, pare-feu, mauvais réseau.',
    fix: 'Vérifier que la cible est joignable depuis le conteneur (Export tech support : sondes réseau) et les règles de pare-feu de l\'hôte.',
  },
  {
    id: 'auth',
    re: /password authentication failed|authentication failed|access denied for user|invalid credentials|\b401\b.*unauthori[sz]ed|unauthori[sz]ed.*\b401\b/i,
    severity: 'error',
    title: 'Identifiants refusés',
    explain: 'Le service se connecte à une base ou une API avec un utilisateur ou un mot de passe refusé (variable erronée, compte changé, version différente du serveur distant).',
    fix: 'Vérifier les variables d\'utilisateur et de mot de passe (onglet Variables), puis Redéployer (Redémarrer ne relit pas les variables).',
  },
  {
    id: 'tls',
    re: /certificate (verify failed|has expired)|x509:|self[- ]signed certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to get local issuer certificate/i,
    severity: 'error',
    title: 'Certificat TLS refusé',
    explain: 'Le service ne fait pas confiance au certificat d\'un serveur distant (autorité interne inconnue, certificat expiré, inspection TLS).',
    fix: 'Fournir l\'autorité au conteneur (montage du certificat, variable du type NODE_EXTRA_CA_CERTS / SSL_CERT_FILE) ou corriger le certificat distant.',
  },
  {
    id: 'exec-format',
    re: /exec format error/i,
    severity: 'error',
    title: 'Image d\'une autre architecture',
    explain: 'L\'image a été construite pour une autre architecture (arm64 / amd64) que celle de l\'hôte.',
    fix: 'Utiliser une image multi-architecture ou le tag de la bonne architecture (Mises à niveau, ou modifier l\'image dans le Compose).',
  },
  {
    id: 'missing-module',
    re: /Cannot find module|ModuleNotFoundError|No module named|MODULE_NOT_FOUND/,
    severity: 'error',
    title: 'Module de l\'application introuvable',
    explain: 'Le code de l\'image ne trouve pas une de ses dépendances : image incomplète ou cassée, ou un montage masque le dossier de l\'application.',
    fix: 'Vérifier qu\'aucun volume ne recouvre le dossier de l\'application ; reconstruire l\'image (build propre) ou revenir à la version précédente.',
  },
  {
    id: 'missing-env',
    re: /(environment variable|env var)\S*\s.*(not set|missing|required|undefined)|\bis not set\b|must be set|required variable/i,
    severity: 'error',
    title: 'Variable d\'environnement manquante',
    explain: 'Le service attend une variable qui n\'est pas fournie.',
    fix: 'L\'ajouter dans l\'onglet Variables (secrète si c\'est un mot de passe), au besoin injectée dans ce service seul, puis Redéployer.',
  },
  {
    id: 'config-parse',
    re: /(yaml|json|toml|ini|xml|config(uration)?)\b.*(parse|syntax) error|failed to (parse|load) (config|configuration)|invalid configuration|Unexpected token .* in JSON/i,
    severity: 'error',
    title: 'Fichier de configuration illisible',
    explain: 'Un fichier de configuration du service contient une erreur de syntaxe (modification manuelle, écriture interrompue).',
    fix: `Ouvrir le fichier (${EXPLORER}) ; restaurer sa copie .console-….bak si la console l'a modifié, sinon corriger la syntaxe.`,
  },
  {
    id: 'too-many-files',
    re: /too many open files|EMFILE/i,
    severity: 'warning',
    title: 'Trop de fichiers ouverts',
    explain: 'Le processus atteint la limite de fichiers ouverts (ulimit nofile).',
    fix: 'Relever la limite dans le Compose (ulimits: nofile) puis Redéployer.',
  },
  {
    id: 'segfault',
    re: /segmentation fault|SIGSEGV|core dumped/i,
    severity: 'error',
    title: 'Plantage (segmentation fault)',
    explain: 'Le programme a accédé à une mémoire invalide : bug de l\'image, bibliothèque incompatible, ou fichier de données corrompu.',
    fix: 'Revenir à la version précédente de l\'image (Mises à niveau) ; si cela suit un arrêt brutal, vérifier les fichiers de données.',
  },
  {
    id: 'go-panic',
    re: /^panic: |goroutine \d+ \[running\]/,
    severity: 'error',
    title: 'Plantage du programme (panic Go)',
    explain: 'Le programme (écrit en Go) s\'est arrêté sur une erreur inattendue ; la ligne « panic: » donne la raison.',
    fix: 'Lire la ligne « panic: » ; souvent une configuration absente ou invalide, sinon un bug de la version : revenir à la précédente.',
  },
  {
    id: 'python-traceback',
    re: /Traceback \(most recent call last\)/,
    severity: 'error',
    title: 'Exception Python',
    explain: 'Le programme (Python) s\'est arrêté sur une exception ; la dernière ligne de la trace en donne le type et la raison.',
    fix: 'Lire la dernière ligne de la trace (ex. « …Error: … ») : identifiants, fichier ou service distant en cause.',
  },
  {
    id: 's6-init',
    re: /cont-init.*exited [1-9]|\[cont-init\.d\].*exited [1-9]|s6-.*: fatal/i,
    severity: 'error',
    title: 'Script d\'initialisation de l\'image en échec',
    explain: 'Un script de démarrage de l\'image (LinuxServer / s6-overlay) a échoué avant le lancement de l\'application.',
    fix: 'Les lignes juste avant indiquent le script et la cause ; souvent des droits (PUID/PGID) ou un dossier /config inaccessible.',
  },
  {
    id: 'no-such-file',
    re: /no such file or directory|ENOENT/i,
    severity: 'warning',
    title: 'Fichier ou dossier introuvable',
    explain: 'Le service cherche un fichier qui n\'existe pas : montage absent ou vide, chemin erroné dans la configuration.',
    fix: `Vérifier les montages (Aperçu du conteneur → Volumes) et le contenu attendu (${EXPLORER}).`,
  },
]

const ORDER: Record<InsightSeverity, number> = { error: 0, warning: 1, info: 2 }

/** Constatations sur les lignes (les plus récentes comptent : dernière occurrence retenue). */
export function analyzeLogs(lines: readonly string[]): LogInsight[] {
  const found = new Map<string, LogInsight>()
  lines.forEach((line, index) => {
    for (const r of RULES) {
      if (!r.re.test(line)) continue
      const cur = found.get(r.id)
      found.set(r.id, { id: r.id, severity: r.severity, title: r.title, explain: r.explain, fix: r.fix, count: (cur?.count ?? 0) + 1, sample: line.trim().slice(0, 400), lastIndex: index })
    }
  })
  // Raison donnée par la ligne suivant l'exception (what(): …, dernière ligne d'une trace Python).
  const cpp = found.get('cpp-terminate')
  const what = lines.find((l, i) => cpp && i > cpp.lastIndex && /what\(\):/.test(l))
  if (cpp && what) cpp.sample = `${cpp.sample} — ${what.trim()}`.slice(0, 400)
  const hidden = new Set(RULES.filter(r => found.has(r.id)).flatMap(r => r.hides ?? []))
  return [...found.values()].filter(i => !hidden.has(i.id)).sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || b.lastIndex - a.lastIndex)
}

/** Règles connues (pour l'aide et les tests). */
export const LOG_RULE_IDS = RULES.map(r => r.id)
