/**
 * Variables lues seulement à l'initialisation des données (premier démarrage,
 * création de la base) : les modifier puis redéployer ne change pas la valeur
 * en service, et peut casser la connexion entre services.
 */
const INIT_ONLY: { test: RegExp, hint: string }[] = [
  {
    test: /^HARBOR_ADMIN_PASSWORD$/,
    hint: 'Mot de passe admin initial de Harbor, lu seulement au premier démarrage : un redéploiement ne le change pas. Le changer dans Harbor (profil admin), puis reporter ici la nouvelle valeur.',
  },
  {
    test: /^(HARBOR_DB_PASSWORD|POSTGRES_PASSWORD|POSTGRES_USER|MYSQL_ROOT_PASSWORD|MYSQL_PASSWORD|MYSQL_USER|MARIADB_ROOT_PASSWORD|MARIADB_PASSWORD|MARIADB_USER)$/,
    hint: 'Lue seulement à la création de la base : la changer ici ne modifie pas la base existante, et les services qui s\'y connectent seront refusés. Changer d\'abord le mot de passe dans la base.',
  },
  {
    test: /^(POSTGRESQL_PASSWORD|DB_PASSWORD|DATABASE_PASSWORD)$/,
    hint: 'Doit rester égale au mot de passe réel de la base : ne la changer qu\'après avoir changé celui-ci dans la base.',
  },
]

export function initOnlyHint(name: string): string | null {
  return INIT_ONLY.find(r => r.test.test(name))?.hint ?? null
}
