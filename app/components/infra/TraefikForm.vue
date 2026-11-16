<script setup lang="ts">
import { DOMAIN_PATTERN_RE, PROXY_PROVIDERS, PROXY_PROVIDER_LABEL, type TraefikConfigInput } from '#shared/schemas/infra'

const props = defineProps<{ networks: string[], detectedNetworks?: string[], errors?: Record<string, string> }>()
const model = defineModel<TraefikConfigInput>({ required: true })
const uid = useId()
const err = (f: string) => props.errors?.[f] ?? null
const validateDomain = (v: string) => (DOMAIN_PATTERN_RE.test(v.toLowerCase()) ? null : 'Domaine invalide (ex. *.apps.interne.fr)')
const validateName = (v: string) => (/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,99}$/.test(v) ? null : 'Nom invalide')
const HINT: Record<TraefikConfigInput['provider'], string> = {
  'traefik': 'Labels traefik.* générés sur les services exposés.',
  'nginx-proxy': 'nginx-proxy (jwilder) : variables VIRTUAL_HOST, VIRTUAL_PORT, VIRTUAL_PATH (et LETSENCRYPT_HOST) générées sur les services exposés.',
  'nginx': 'nginx classique : un fichier server { } par projet écrit dans le dossier des configurations du conteneur nginx, puis nginx rechargé (signal HUP ; configuration invalide refusée et retirée).',
}
const nullable = (v: string) => v.trim() || null
</script>

<template>
  <div class="grid">
    <UiField class="span-all" label="Reverse proxy" :for="`${uid}-prov`" :hint="HINT[model.provider]">
      <select :id="`${uid}-prov`" v-model="model.provider" class="input">
        <option v-for="p in PROXY_PROVIDERS" :key="p" :value="p">{{ PROXY_PROVIDER_LABEL[p] }}</option>
      </select>
    </UiField>
    <template v-if="model.provider === 'nginx'">
      <UiField label="Conteneur nginx" :for="`${uid}-ngx`" :error="err('nginxContainer')" hint="Nom du conteneur, branché sur le réseau du proxy" required>
        <input :id="`${uid}-ngx`" :value="model.nginxContainer ?? ''" class="input mono" placeholder="nginx" @input="model.nginxContainer = nullable(($event.target as HTMLInputElement).value)">
      </UiField>
      <UiField label="Dossier des configurations" :for="`${uid}-ngxdir`" :error="err('nginxConfDir')" hint="Dans le conteneur ; à monter depuis l'hôte pour survivre à sa recréation">
        <input :id="`${uid}-ngxdir`" v-model.trim="model.nginxConfDir" class="input mono">
      </UiField>
      <UiField label="Certificat TLS" :for="`${uid}-crt`" :error="err('nginxSslCertificate')" hint="Chemin dans le conteneur, {host} = domaine ; vide : HTTP seul">
        <input :id="`${uid}-crt`" :value="model.nginxSslCertificate ?? ''" class="input mono" placeholder="/etc/nginx/certs/{host}/fullchain.pem" @input="model.nginxSslCertificate = nullable(($event.target as HTMLInputElement).value)">
      </UiField>
      <UiField label="Clé du certificat" :for="`${uid}-key`" :error="err('nginxSslCertificateKey')">
        <input :id="`${uid}-key`" :value="model.nginxSslCertificateKey ?? ''" class="input mono" placeholder="/etc/nginx/certs/{host}/privkey.pem" @input="model.nginxSslCertificateKey = nullable(($event.target as HTMLInputElement).value)">
      </UiField>
      <UiField label="Journal d'accès des sites" :for="`${uid}-alog`" :error="err('nginxAccessLog')" hint="Format de la console : domaine, statut, durées et amont, consultables dans « Logs d'accès »">
        <select :id="`${uid}-alog`" v-model="model.nginxAccessLog" class="input">
          <option value="json">Format de la console (JSON, sortie du conteneur)</option>
          <option value="default">Celui de la configuration nginx</option>
          <option value="off">Désactivé</option>
        </select>
      </UiField>
      <UiField label="Dossier des certificats de la console" :for="`${uid}-certs`" :error="err('nginxCertsDir')" hint="Certificats importés ou Let's Encrypt déposés ici (<domaine>.crt / .key), prioritaires sur les chemins ci-dessus">
        <input :id="`${uid}-certs`" v-model.trim="model.nginxCertsDir" class="input mono">
      </UiField>
    </template>
    <UiField v-if="model.provider === 'nginx-proxy'" label="Conteneur nginx-proxy" :for="`${uid}-ngxp`" :error="err('nginxContainer')" hint="Facultatif : pour y déposer les certificats importés (/etc/nginx/certs)">
      <input :id="`${uid}-ngxp`" :value="model.nginxContainer ?? ''" class="input mono" placeholder="nginx-proxy" @input="model.nginxContainer = nullable(($event.target as HTMLInputElement).value)">
    </UiField>
    <template v-if="model.provider === 'nginx' || (model.provider === 'nginx-proxy' && !model.letsencrypt)">
      <UiField label="Let's Encrypt : e-mail du compte" :for="`${uid}-acme`" :error="err('nginxAcmeEmail')" :hint="model.provider === 'nginx' ? 'Vide : désactivé. Renseigné : la console obtient et renouvelle les certificats (défi DNS-01 si un compte DNS couvre le domaine, sinon HTTP-01 servi par nginx sur le port 80)' : 'Vide : désactivé. Renseigné : certificats obtenus par DNS-01 pour les domaines couverts par un compte DNS (Administration → Comptes DNS)'">
        <input :id="`${uid}-acme`" :value="model.nginxAcmeEmail ?? ''" class="input" type="email" placeholder="admin@exemple.fr" @input="model.nginxAcmeEmail = nullable(($event.target as HTMLInputElement).value)">
      </UiField>
      <UiField v-if="model.nginxAcmeEmail" label="Autorité ACME" :for="`${uid}-acmedir`" :error="err('nginxAcmeDirectory')" hint="Production, test (staging, certificats non reconnus) ou URL d'annuaire d'une autorité interne">
        <input :id="`${uid}-acmedir`" v-model.trim="model.nginxAcmeDirectory" class="input mono" list="acme-directories">
        <datalist id="acme-directories"><option value="letsencrypt" /><option value="letsencrypt-staging" /></datalist>
      </UiField>
    </template>
    <UiSwitch v-if="model.provider === 'nginx-proxy'" v-model="model.letsencrypt" class="span-all" label="Certificats Let's Encrypt (acme-companion : LETSENCRYPT_HOST)" />
    <UiField :label="`Réseau ${PROXY_PROVIDER_LABEL[model.provider]}`" :for="`${uid}-net`" :error="err('networkName')" hint="Seuls les réseaux autorisés sont proposés" required>
      <select :id="`${uid}-net`" v-model="model.networkName" class="input">
        <option value="" disabled>Choisir…</option>
        <option v-for="n in networks" :key="n" :value="n">{{ n }}{{ detectedNetworks?.includes(n) ? ' (détecté)' : '' }}</option>
      </select>
    </UiField>
    <UiField label="Exposition" :for="`${uid}-exp`" :error="err('exposure')">
      <select :id="`${uid}-exp`" v-model="model.exposure" class="input">
        <option value="internal">Interne</option>
        <option value="external">Externe</option>
      </select>
    </UiField>
    <UiField v-if="model.provider === 'traefik'" label="Entrypoint HTTP" :for="`${uid}-http`" :error="err('entrypointHttp')">
      <input :id="`${uid}-http`" v-model.trim="model.entrypointHttp" class="input mono">
    </UiField>
    <UiField v-if="model.provider === 'traefik'" label="Entrypoint HTTPS" :for="`${uid}-https`" :error="err('entrypointHttps')">
      <input :id="`${uid}-https`" v-model.trim="model.entrypointHttps" class="input mono">
    </UiField>
    <UiField v-if="model.provider === 'traefik'" label="Resolver TLS" :for="`${uid}-res`" hint="Vide : certificat par défaut de Traefik" :error="err('certResolver')">
      <input :id="`${uid}-res`" :value="model.certResolver ?? ''" class="input mono" placeholder="letsencrypt" @input="model.certResolver = ($event.target as HTMLInputElement).value.trim() || null">
    </UiField>
    <UiField v-if="model.provider === 'traefik'" label="Convention de nommage des routeurs" :for="`${uid}-pat`" :error="err('routerNamePattern')">
      <input :id="`${uid}-pat`" v-model.trim="model.routerNamePattern" class="input mono">
    </UiField>
    <UiField class="span-all" label="Domaines autorisés" :for="`${uid}-dom`" :error="err('allowedDomains')" hint="Entrée pour ajouter ; joker en premier niveau uniquement (*.apps.interne.fr)">
      <UiTagInput :id="`${uid}-dom`" v-model="model.allowedDomains" placeholder="*.apps.interne.fr" :validate="validateDomain" :max="100" />
    </UiField>
    <UiField v-if="model.provider === 'traefik'" class="span-all" label="Middlewares par défaut" :for="`${uid}-mw`" :error="err('defaultMiddlewares')">
      <UiTagInput :id="`${uid}-mw`" v-model="model.defaultMiddlewares" placeholder="secure-headers@file" :validate="validateName" :max="20" />
    </UiField>
    <UiSwitch v-model="model.redirectToHttps" class="span-all" label="Rediriger HTTP vers HTTPS" />
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--space-2) var(--space-4); }
.span-all { grid-column: 1 / -1; }
</style>
