/**
 * Contrat de l'adaptateur des hôtes Docker, joints par leur agent Portainer.
 * Toute la plateforme passe par cette interface : le navigateur ne parle jamais
 * aux agents, et les implémentations (agent réel, mock) sont interchangeables.
 *
 * Périmètre initial : Docker Standalone. Les types Swarm/Kubernetes sont
 * modélisés pour que l'extension ne casse pas le contrat.
 */
export type HostTransport = 'agent' | 'ssh'

/** Connexion SSH à un hôte : l'API Docker passe par le socket de l'hôte, les fichiers par SFTP. */
export interface SshConnection {
  host: string
  port: number
  username: string
  /** Un des deux : mot de passe, ou clé privée (phrase de passe facultative). Jamais journalisés. */
  password?: string
  privateKey?: string
  passphrase?: string
  /** Empreinte confirmée de la clé d'hôte (« SHA256:… ») ; null : connexion refusée. */
  hostKey: string | null
  /** Socket Docker sur l'hôte. */
  dockerSocket: string
}

export interface PortainerConnection {
  /** Transport : agent Portainer (défaut) ou SSH. */
  transport?: HostTransport
  url: string
  /** AGENT_SECRET de l'agent (jamais transmis : il sert à signer les requêtes). Vide en SSH. */
  token: string
  tlsVerify: boolean
  caCertPem?: string | null
  ssh?: SshConnection
}

export type EndpointKind = 'docker_standalone' | 'docker_swarm' | 'kubernetes' | 'other'

export interface PortainerVersion {
  version: string
  /** Seule la branche 2.x est supportée. */
  supported: boolean
}

export interface PortainerEndpoint {
  id: number
  name: string
  kind: EndpointKind
  url: string | null
  online: boolean
  /** Type brut Portainer (1 Docker, 2 Agent, 4 Edge, 5-7 Kubernetes...). */
  rawType: number
}

export interface DockerNetwork {
  id: string
  name: string
  driver: string
  scope: string
  internal: boolean
  attachable: boolean
  labels: Record<string, string>
}

export interface DockerVolume {
  name: string
  driver: string
  mountpoint: string | null
  labels: Record<string, string>
}

export interface DockerContainer {
  id: string
  names: string[]
  image: string
  state: string
  status: string
  labels: Record<string, string>
  networks: string[]
  createdAt: string
  imageId?: string
  command?: string
  ports?: { ip: string | null, privatePort: number, publicPort: number | null, type: string }[]
  mounts?: { type: string, source: string | null, destination: string, rw: boolean, name: string | null }[]
}

/** Moteur Docker d'un endpoint (lecture seule). */
export interface DockerEngineInfo {
  containers: number
  running: number
  paused: number
  stopped: number
  images: number
  serverVersion: string | null
  os: string | null
  kernel: string | null
  cpus: number | null
  memoryBytes: number | null
  name: string | null
}

/** Inspection détaillée d'un conteneur. Les valeurs d'environnement ne sont jamais renvoyées. */
export interface ContainerDetail {
  id: string
  name: string
  image: string
  imageId: string
  createdAt: string
  state: { status: string, running: boolean, restarting: boolean, oomKilled: boolean, exitCode: number | null, startedAt: string | null, finishedAt: string | null, error: string | null }
  restartCount: number
  restartPolicy: string | null
  health: { status: string, failingStreak: number, log: { start: string, exitCode: number, output: string }[] } | null
  command: string[]
  entrypoint: string[]
  workingDir: string | null
  user: string | null
  envKeys: string[]
  labels: Record<string, string>
  mounts: { type: string, source: string | null, destination: string, rw: boolean, name: string | null }[]
  networks: { name: string, ip: string | null, aliases: string[] }[]
  ports: { container: string, host: string | null }[]
}

/** Occupation disque du moteur Docker (docker system df). */
export interface DockerDiskUsage {
  images: { count: number, active: number, sizeBytes: number, reclaimableBytes: number }
  containers: { count: number, running: number, sizeBytes: number, reclaimableBytes: number }
  volumes: { count: number, active: number, sizeBytes: number, reclaimableBytes: number }
  buildCache: { count: number, sizeBytes: number, reclaimableBytes: number }
}

export interface DockerVolumeUsage { name: string, driver: string, labels: Record<string, string>, sizeBytes: number | null, refCount: number | null, createdAt: string | null }
/** Réseau complet : de quoi le recréer à l'identique (autre sous-réseau) et y reconnecter ses conteneurs. */
export interface NetworkDetail {
  id: string
  name: string
  driver: string
  scope: string
  internal: boolean
  attachable: boolean
  enableIPv6: boolean
  options: Record<string, string>
  labels: Record<string, string>
  ipam: { driver: string, options: Record<string, string>, config: { subnet: string, gateway?: string, ipRange?: string }[] }
  containers: { id: string, name: string, ipv4: string | null }[]
}
export type NetworkSpec = Omit<NetworkDetail, 'id' | 'scope' | 'containers'>

export interface DockerNetworkInfo { id: string, name: string, driver: string, scope: string, labels: Record<string, string>, internal: boolean, createdAt: string | null, subnets?: string[] }
export interface DockerImageInfo { id: string, tags: string[], sizeBytes: number, createdAt: string, labels: Record<string, string>, containers: number, dangling: boolean }
export interface PruneResult { deleted: string[], reclaimedBytes: number }

export interface ContainerStats {
  cpuPercent: number | null
  memoryBytes: number | null
  memoryLimitBytes: number | null
  netRxBytes: number | null
  netTxBytes: number | null
  blockReadBytes: number | null
  blockWriteBytes: number | null
  pids: number | null
  at: string
}

/**
 * Configuration brute d'un conteneur, à usage interne du serveur (lecture du
 * proxy, reprise de l'existant). Contient les valeurs d'environnement : jamais
 * renvoyée au client, journalisée ou incluse dans un message d'erreur.
 */
export interface ContainerConfig {
  id: string
  name: string
  image: string
  imageId: string
  state: string
  entrypoint: string[] | null
  cmd: string[] | null
  workingDir: string | null
  user: string | null
  env: string[]
  labels: Record<string, string>
  healthcheck: { test: string[], intervalNs: number | null, timeoutNs: number | null, retries: number | null, startPeriodNs: number | null } | null
  restartPolicy: string | null
  privileged: boolean
  capAdd: string[]
  capDrop: string[]
  networkMode: string | null
  portBindings: { container: string, hostIp: string | null, hostPort: string | null }[]
  exposedPorts: string[]
  mounts: { type: string, source: string | null, destination: string, rw: boolean, name: string | null }[]
  networks: { name: string, aliases: string[], staticIp?: string | null }[]
  extraHosts: string[]
  stopSignal: string | null
  tty: boolean
}

export interface ImageDefaults {
  env: string[]
  cmd: string[] | null
  entrypoint: string[] | null
  workingDir: string | null
  user: string | null
  labels: Record<string, string>
  healthcheck: string[] | null
}

export interface DockerImage {
  id: string
  tags: string[]
  sizeBytes: number
  createdAt: string
}

export interface PortainerStack {
  id: number
  name: string
  endpointId: number
  status: 'active' | 'inactive'
  type: 'compose' | 'swarm' | 'kubernetes'
}

export interface DiscoveryResult {
  endpoint: PortainerEndpoint
  networks: DockerNetwork[]
  volumes: DockerVolume[]
  containers: DockerContainer[]
  images: DockerImage[]
}

export interface ContainerState {
  id: string
  name: string
  service: string | null
  status: string
  running: boolean
  /** null : pas de healthcheck défini. */
  health: 'starting' | 'healthy' | 'unhealthy' | null
  exitCode: number | null
  restartCount: number
  startedAt: string | null
  image: string
  /** Identifiant de l'image réellement exécutée (sha256:…). */
  imageId: string
  labels: Record<string, string>
}

export interface ImageInfo {
  id: string
  repoDigests: string[]
  created: string | null
}

export interface StackDeployInput {
  endpointId: number
  name: string
  composeContent: string
  env: { name: string, value: string }[]
  /** Retirer les images des registres avant de relancer (mise à jour manuelle). */
  pullImage?: boolean
  /** Avertissements à journaliser (image non récupérée, version de l'hôte conservée…). */
  onWarning?: (message: string) => void | Promise<void>
}

export interface OneShotSpec {
  /** Image complète avec son tag (jamais « latest » implicite). */
  image: string
  /** Remplace le point d'entrée de l'image (sinon celui de l'image). */
  entrypoint?: string[]
  cmd: string[]
  /** Montages « hôte:conteneur[:options] » (chemins validés par l'appelant). */
  binds: string[]
  /** Fichiers déposés dans le conteneur avant le démarrage (chemins absolus). */
  files: { path: string, content: string, mode?: number }[]
  /** Chemins (fichiers ou dossiers) relevés après l'exécution. */
  outputs: string[]
  outputLimits: { maxBytes: number, maxFiles: number }
  labels: Record<string, string>
  timeoutMs: number
  /** Mémoire maximale (512 Mo par défaut). */
  memoryMb?: number
  /** Réseau (par défaut aucun) : « container:<id> » partage l'espace réseau d'un conteneur (sondes). */
  networkMode?: string
}

export interface OneShotResult {
  exitCode: number
  logs: string[]
  outputs: Record<string, { path: string, content: string }[] | null>
}

/** Conteneur « porteur » (jamais démarré) : accès aux fichiers d'un volume ou d'un dossier de l'hôte par l'API d'archives. */
export interface HolderSpec {
  image: string
  /** Montages « source:destination[:options] » (chemins validés par l'appelant). */
  binds: string[]
  labels: Record<string, string>
}

export interface PortainerAdapter {
  getVersion(conn: PortainerConnection): Promise<PortainerVersion>
  listEndpoints(conn: PortainerConnection): Promise<PortainerEndpoint[]>
  listNetworks(conn: PortainerConnection, endpointId: number): Promise<DockerNetwork[]>
  listVolumes(conn: PortainerConnection, endpointId: number): Promise<DockerVolume[]>
  listContainers(conn: PortainerConnection, endpointId: number): Promise<DockerContainer[]>
  listImages(conn: PortainerConnection, endpointId: number): Promise<DockerImage[]>
  listStacks(conn: PortainerConnection): Promise<PortainerStack[]>
  createStack(conn: PortainerConnection, input: StackDeployInput): Promise<PortainerStack>
  updateStack(conn: PortainerConnection, stackId: number, input: StackDeployInput): Promise<PortainerStack>
  stopStack(conn: PortainerConnection, stackId: number, endpointId: number): Promise<void>
  startStack(conn: PortainerConnection, stackId: number, endpointId: number): Promise<void>
  deleteStack(conn: PortainerConnection, stackId: number, endpointId: number): Promise<void>
  findStack(conn: PortainerConnection, name: string, endpointId: number): Promise<PortainerStack | null>
  /** Conteneurs d'un projet Compose (label com.docker.compose.project), avec leur état détaillé. */
  stackContainers(conn: PortainerConnection, endpointId: number, stackName: string): Promise<ContainerState[]>
  containerLogs(conn: PortainerConnection, endpointId: number, containerId: string, tail: number): Promise<string[]>
  restartContainer(conn: PortainerConnection, endpointId: number, containerId: string): Promise<void>
  stopContainer(conn: PortainerConnection, endpointId: number, containerId: string): Promise<void>
  startContainer(conn: PortainerConnection, endpointId: number, containerId: string): Promise<void>
  /** Rattache un conteneur à un réseau (alias facultatifs) ; sans effet s'il l'est déjà. */
  connectNetwork(conn: PortainerConnection, endpointId: number, network: string, containerId: string, aliases?: string[]): Promise<void>
  /** Détache un conteneur d'un réseau ; sans effet s'il ne l'est pas. */
  disconnectNetwork(conn: PortainerConnection, endpointId: number, network: string, containerId: string): Promise<void>
  /** Arrête et supprime un conteneur (ses volumes nommés sont conservés). */
  removeContainer(conn: PortainerConnection, endpointId: number, containerId: string): Promise<void>
  imageInfo(conn: PortainerConnection, endpointId: number, imageId: string): Promise<ImageInfo | null>
  engineInfo(conn: PortainerConnection, endpointId: number): Promise<DockerEngineInfo>
  inspectContainer(conn: PortainerConnection, endpointId: number, containerId: string): Promise<ContainerDetail | null>
  containerStats(conn: PortainerConnection, endpointId: number, containerId: string): Promise<ContainerStats | null>
  diskUsage(conn: PortainerConnection, endpointId: number): Promise<{ usage: DockerDiskUsage, volumes: DockerVolumeUsage[], images: DockerImageInfo[] }>
  listNetworksDetailed(conn: PortainerConnection, endpointId: number): Promise<DockerNetworkInfo[]>
  pruneContainers(conn: PortainerConnection, endpointId: number, filters: Record<string, string[]>): Promise<PruneResult>
  pruneImages(conn: PortainerConnection, endpointId: number, filters: Record<string, string[]>): Promise<PruneResult>
  pruneBuildCache(conn: PortainerConnection, endpointId: number, opts: { all: boolean, until?: string }): Promise<PruneResult>
  removeVolume(conn: PortainerConnection, endpointId: number, name: string): Promise<void>
  removeImage(conn: PortainerConnection, endpointId: number, id: string): Promise<void>
  removeNetwork(conn: PortainerConnection, endpointId: number, id: string): Promise<void>
  /** Réseau bridge attachable, étiqueté comme créé par la plateforme. */
  createNetwork(conn: PortainerConnection, endpointId: number, name: string): Promise<void>
  inspectNetwork(conn: PortainerConnection, endpointId: number, idOrName: string): Promise<NetworkDetail | null>
  /** Création à partir d'une description complète (driver, options, labels, IPAM) ; renvoie l'identifiant. */
  createNetworkSpec(conn: PortainerConnection, endpointId: number, spec: NetworkSpec): Promise<string>
  /** Fichiers d'un conteneur (archive Docker, lecture seule) ; null si le chemin n'existe pas. */
  readContainerFiles(conn: PortainerConnection, endpointId: number, containerId: string, path: string, limits: { maxBytes: number, maxFiles: number }): Promise<{ path: string, content: string }[] | null>
  /**
   * Conteneur ponctuel (générateur de configuration) : image tirée si absente, sans réseau ni
   * privilège, fichiers d'entrée déposés avant le démarrage, attente bornée, journal et fichiers
   * produits relevés, puis conteneur toujours supprimé.
   */
  runOneShot(conn: PortainerConnection, endpointId: number, spec: OneShotSpec): Promise<OneShotResult>
  /**
   * Sort un conteneur de son projet Compose : recréé à l'identique (configuration, montages,
   * réseaux, ports) sans les labels de Compose, puis démarré ; l'ancien est supprimé (volumes
   * conservés). En cas d'échec, l'ancien est remis en service.
   */
  detachContainer(conn: PortainerConnection, endpointId: number, containerId: string): Promise<{ id: string, name: string }>
  /** Envoie un signal au processus principal d'un conteneur (ex. HUP : nginx relit sa configuration). */
  signalContainer(conn: PortainerConnection, endpointId: number, containerId: string, signal: 'HUP' | 'USR1' | 'USR2'): Promise<void>
  /** Volume nommé (driver local par défaut), étiqueté comme celui d'origine ; sans effet s'il existe déjà. */
  createVolume(conn: PortainerConnection, endpointId: number, spec: { name: string, driver?: string, labels: Record<string, string> }): Promise<void>
  /** Crée un conteneur porteur (image tirée si absente), sans réseau ni démarrage ; renvoie son identifiant. */
  createHolder(conn: PortainerConnection, endpointId: number, spec: HolderSpec): Promise<string>
  /** Image présente sur l'hôte (récupérée au besoin, ou toujours avec force) : identifiant local. */
  pullImage(conn: PortainerConnection, endpointId: number, image: string, opts?: { force?: boolean }): Promise<{ id: string }>
  /**
   * Archive tar d'un chemin d'un conteneur, en flux (aucune limite de taille : copie de données).
   * isDir : nature du chemin (en-tête de Docker).
   */
  openArchive(conn: PortainerConnection, endpointId: number, containerId: string, path: string, timeoutMs: number): Promise<{ stream: import('node:stream').Readable, isDir: boolean }>
  /** Dépose une archive tar (flux) dans un conteneur, extraite sous `path` (propriétaires et droits conservés). */
  putArchive(conn: PortainerConnection, endpointId: number, containerId: string, path: string, body: import('node:stream').Readable, timeoutMs: number): Promise<void>
  /**
   * Session interactive dans un conteneur en marche (`docker exec -it`) : flux brut bidirectionnel (TTY),
   * redimensionnement du terminal et fermeture. La commande est lancée telle quelle (pas d'interprétation).
   */
  openExec(conn: PortainerConnection, endpointId: number, containerId: string, opts: ExecOptions): Promise<ExecSession>
  inspectConfig(conn: PortainerConnection, endpointId: number, containerId: string): Promise<ContainerConfig | null>
  /** Valeurs par défaut définies par l'image (pour ne reprendre que ce qui a été surchargé). */
  imageConfig(conn: PortainerConnection, endpointId: number, image: string): Promise<ImageDefaults | null>
}

export interface ExecOptions {
  cmd: string[]
  cols: number
  rows: number
  /** Utilisateur du processus (défaut : celui du conteneur). */
  user?: string
}

export interface ExecSession {
  /** Flux brut du terminal : lecture = sortie, écriture = saisie. */
  stream: import('node:stream').Duplex
  resize(cols: number, rows: number): Promise<void>
  close(): void
}

export class PortainerError extends Error {
  constructor(
    message: string,
    public readonly kind: 'network' | 'timeout' | 'tls' | 'auth' | 'not_found' | 'unsupported' | 'http',
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'PortainerError'
  }
}

export function isSupportedVersion(version: string): boolean {
  return /^2\.\d+/.test(version)
}

/** Discovery complète d'un endpoint (§5.3), commune à toutes les implémentations. */
export async function discoverEndpoint(adapter: PortainerAdapter, conn: PortainerConnection, endpoint: PortainerEndpoint): Promise<DiscoveryResult> {
  const [networks, volumes, containers, images] = await Promise.all([
    adapter.listNetworks(conn, endpoint.id),
    adapter.listVolumes(conn, endpoint.id),
    adapter.listContainers(conn, endpoint.id),
    adapter.listImages(conn, endpoint.id),
  ])
  return { endpoint, networks, volumes, containers, images }
}
