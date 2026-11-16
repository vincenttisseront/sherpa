/**
 * Modèles fournis avec la plateforme : Compose prêts à déployer, sans secret (mots de passe en variables `${NOM}`,
 * enregistrées comme variables secrètes de la cible à l'application du modèle). Aucun port publié : l'exposition web
 * se règle ensuite (onglet Exposition) ; l'analyse habituelle (ports, réseaux, volumes, versions) s'applique avant tout déploiement.
 */
import type { TemplateCategory, TemplateVariable } from '../schemas/templates'

export interface BuiltinTemplate {
  key: string
  name: string
  description: string
  category: TemplateCategory
  compose: string
  variables: TemplateVariable[]
  notes?: string
}

const pw = (name: string, label: string, description?: string): TemplateVariable => ({ name, label, secret: true, generate: 'password', ...(description ? { description } : {}) })

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    key: 'postgres', name: 'PostgreSQL 17', category: 'Bases de données',
    description: 'Base relationnelle, données dans un volume, sonde de santé.',
    compose: `services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $\${POSTGRES_USER} -d $\${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
volumes:
  pgdata:
`,
    variables: [{ name: 'POSTGRES_USER', label: 'Utilisateur', default: 'app' }, { name: 'POSTGRES_DB', label: 'Base', default: 'app' }, pw('POSTGRES_PASSWORD', 'Mot de passe')],
    notes: 'Aucun port publié : les autres projets joignent la base par un réseau Docker partagé (le service s\'appelle « postgres »).',
  },
  {
    key: 'mariadb', name: 'MariaDB 11', category: 'Bases de données',
    description: 'Base MySQL compatible, données dans un volume.',
    compose: `services:
  mariadb:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: \${MARIADB_ROOT_PASSWORD}
      MARIADB_DATABASE: \${MARIADB_DATABASE}
      MARIADB_USER: \${MARIADB_USER}
      MARIADB_PASSWORD: \${MARIADB_PASSWORD}
    volumes:
      - mariadb:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 5
volumes:
  mariadb:
`,
    variables: [pw('MARIADB_ROOT_PASSWORD', 'Mot de passe root'), { name: 'MARIADB_DATABASE', label: 'Base', default: 'app' }, { name: 'MARIADB_USER', label: 'Utilisateur', default: 'app' }, pw('MARIADB_PASSWORD', 'Mot de passe de l\'utilisateur')],
  },
  {
    key: 'redis', name: 'Redis 7', category: 'Bases de données',
    description: 'Cache et files, mot de passe obligatoire, persistance AOF.',
    compose: `services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    environment:
      REDIS_PASSWORD: \${REDIS_PASSWORD}
    command: ["sh", "-c", "exec redis-server --requirepass \\"$$REDIS_PASSWORD\\" --appendonly yes"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a \\"$$REDIS_PASSWORD\\" ping | grep PONG"]
      interval: 10s
      timeout: 5s
      retries: 5
volumes:
  redisdata:
`,
    variables: [pw('REDIS_PASSWORD', 'Mot de passe')],
  },
  {
    key: 'whoami', name: 'Whoami (test d\'exposition)', category: 'Développement',
    description: 'Petit serveur HTTP qui renvoie les en-têtes reçus : vérifier un domaine, HTTPS et le proxy.',
    compose: `services:
  whoami:
    image: traefik/whoami:v1.10.3
    restart: unless-stopped
`,
    variables: [],
    notes: 'Exposer le service « whoami » sur le port 80 (onglet Exposition) avec un domaine de test.',
  },
  {
    key: 'adminer', name: 'Adminer', category: 'Développement',
    description: 'Interface web d\'administration de bases (PostgreSQL, MySQL, MariaDB…).',
    compose: `services:
  adminer:
    image: adminer:4.8.1
    restart: unless-stopped
`,
    variables: [],
    notes: 'Exposer le service « adminer » sur le port 8080, de préférence derrière un contrôle d\'accès.',
  },
  {
    key: 'mailpit', name: 'Mailpit', category: 'Développement',
    description: 'Boîte de réception de test : capte les emails sortants des applications de développement.',
    compose: `services:
  mailpit:
    image: axllent/mailpit:v1.21
    restart: unless-stopped
    volumes:
      - mailpit:/data
    environment:
      MP_DATABASE: /data/mailpit.db
volumes:
  mailpit:
`,
    variables: [],
    notes: 'Interface web sur le port 8025 ; SMTP sur le port 1025 (réseau Docker partagé).',
  },
  {
    key: 'uptime-kuma', name: 'Uptime Kuma', category: 'Supervision',
    description: 'Surveillance de disponibilité (HTTP, TCP, ping) avec alertes.',
    compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    volumes:
      - kuma:/app/data
volumes:
  kuma:
`,
    variables: [],
    notes: 'Exposer le service « uptime-kuma » sur le port 3001.',
  },
  {
    key: 'grafana', name: 'Grafana', category: 'Supervision',
    description: 'Tableaux de bord et alertes pour vos métriques et journaux.',
    compose: `services:
  grafana:
    image: grafana/grafana-oss:11.3.0
    restart: unless-stopped
    environment:
      GF_SECURITY_ADMIN_USER: \${GRAFANA_ADMIN_USER}
      GF_SECURITY_ADMIN_PASSWORD: \${GRAFANA_ADMIN_PASSWORD}
      GF_SERVER_ROOT_URL: \${GRAFANA_URL}
    volumes:
      - grafana:/var/lib/grafana
volumes:
  grafana:
`,
    variables: [{ name: 'GRAFANA_ADMIN_USER', label: 'Administrateur', default: 'admin' }, pw('GRAFANA_ADMIN_PASSWORD', 'Mot de passe administrateur'), { name: 'GRAFANA_URL', label: 'Adresse publique', default: 'https://grafana.example.org', description: 'Celle du domaine exposé.' }],
    notes: 'Exposer le service « grafana » sur le port 3000.',
  },
  {
    key: 'vaultwarden', name: 'Vaultwarden', category: 'Applications',
    description: 'Gestionnaire de mots de passe compatible Bitwarden, léger.',
    compose: `services:
  vaultwarden:
    image: vaultwarden/server:1.32.0
    restart: unless-stopped
    environment:
      DOMAIN: \${VAULTWARDEN_DOMAIN}
      ADMIN_TOKEN: \${VAULTWARDEN_ADMIN_TOKEN}
      SIGNUPS_ALLOWED: \${VAULTWARDEN_SIGNUPS}
    volumes:
      - vaultwarden:/data
volumes:
  vaultwarden:
`,
    variables: [
      { name: 'VAULTWARDEN_DOMAIN', label: 'Adresse publique', default: 'https://vault.example.org' },
      { name: 'VAULTWARDEN_SIGNUPS', label: 'Inscriptions ouvertes (true/false)', default: 'false' },
      { name: 'VAULTWARDEN_ADMIN_TOKEN', label: 'Jeton de l\'interface /admin', secret: true, generate: 'hex' },
    ],
    notes: 'Exposer le service « vaultwarden » sur le port 80, en HTTPS (obligatoire pour les clients Bitwarden).',
  },
  {
    key: 'gitea', name: 'Gitea', category: 'Développement',
    description: 'Forge Git légère (dépôts, tickets, CI), base SQLite.',
    compose: `services:
  gitea:
    image: gitea/gitea:1.22
    restart: unless-stopped
    environment:
      GITEA__database__DB_TYPE: sqlite3
      GITEA__server__ROOT_URL: \${GITEA_URL}
      GITEA__security__INSTALL_LOCK: "true"
    volumes:
      - gitea:/data
volumes:
  gitea:
`,
    variables: [{ name: 'GITEA_URL', label: 'Adresse publique', default: 'https://git.example.org' }],
    notes: 'Exposer le service « gitea » sur le port 3000. Le premier compte se crée en ligne de commande : « gitea admin user create ».',
  },
  {
    key: 'minio', name: 'MinIO', category: 'Stockage',
    description: 'Stockage d\'objets compatible S3 avec console web.',
    compose: `services:
  minio:
    image: minio/minio:RELEASE.2024-10-13T13-34-11Z
    restart: unless-stopped
    command: ["server", "/data", "--console-address", ":9001"]
    environment:
      MINIO_ROOT_USER: \${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD}
    volumes:
      - minio:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 15s
      timeout: 5s
      retries: 5
volumes:
  minio:
`,
    variables: [{ name: 'MINIO_ROOT_USER', label: 'Utilisateur racine', default: 'minioadmin' }, pw('MINIO_ROOT_PASSWORD', 'Mot de passe racine', '8 caractères minimum.')],
    notes: 'Console web sur le port 9001, API S3 sur le port 9000.',
  },
  {
    key: 'wordpress', name: 'WordPress + MariaDB', category: 'Applications',
    description: 'Site WordPress avec sa base MariaDB, fichiers et données en volumes.',
    compose: `services:
  wordpress:
    image: wordpress:6.7-apache
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_NAME: \${WORDPRESS_DB_NAME}
      WORDPRESS_DB_USER: \${WORDPRESS_DB_USER}
      WORDPRESS_DB_PASSWORD: \${WORDPRESS_DB_PASSWORD}
    volumes:
      - wp-content:/var/www/html
  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: \${WORDPRESS_DB_ROOT_PASSWORD}
      MARIADB_DATABASE: \${WORDPRESS_DB_NAME}
      MARIADB_USER: \${WORDPRESS_DB_USER}
      MARIADB_PASSWORD: \${WORDPRESS_DB_PASSWORD}
    volumes:
      - wp-db:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 10
volumes:
  wp-content:
  wp-db:
`,
    variables: [{ name: 'WORDPRESS_DB_NAME', label: 'Base', default: 'wordpress' }, { name: 'WORDPRESS_DB_USER', label: 'Utilisateur de la base', default: 'wordpress' }, pw('WORDPRESS_DB_PASSWORD', 'Mot de passe de la base'), pw('WORDPRESS_DB_ROOT_PASSWORD', 'Mot de passe root de la base')],
    notes: 'Exposer le service « wordpress » sur le port 80 ; l\'installation se termine dans le navigateur.',
  },
]
