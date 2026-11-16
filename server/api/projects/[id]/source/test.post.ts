import { isComposeFile } from '../../../../lib/zip'
import { requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { accessAdvice, tokenKind } from '../../../../lib/github'
import { getProjectSource, github, githubCredentials, githubErrorToHttp, repoComposePath } from '../../../../services/sources'

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Teste l\'accès au dépôt GitHub (public ou privé) : visibilité, nature du token, commit résolu, fichiers Compose, conseils' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'project:update', { projectId: id })
  const s = await getProjectSource(id)
  if (!s || s.kind !== 'github' || !s.refType || !s.ref) throw createError({ statusCode: 422, statusMessage: 'Enregistrer d\'abord une source GitHub complète' })
  try {
    const src = await githubCredentials(s)
    const gh = github()
    const repo = await gh.repository(src)
    const commit = await gh.resolve(src, s.refType, s.ref)
    const tree = await gh.tree(src, commit.sha)
    const prefix = s.subdirectory ? `${s.subdirectory}/` : ''
    const composeFiles = tree.entries.filter(e => e.type === 'blob' && e.path.startsWith(prefix) && isComposeFile(e.path)).map(e => e.path)
    const composePath = repoComposePath(s)
    const kind = tokenKind(src.token)
    const advice = accessAdvice(repo.visibility, kind, repo.scopes)
    if (repo.archived) advice.push({ level: 'info', message: 'Dépôt archivé (lecture seule) sur GitHub.' })
    return {
      repository: { fullName: repo.fullName, private: repo.private, visibility: repo.visibility, defaultBranch: repo.defaultBranch, htmlUrl: repo.htmlUrl, archived: repo.archived },
      access: { authenticated: kind !== 'none', tokenKind: kind, advice },
      commit, composeFiles, composePath, composeFound: composeFiles.includes(composePath), submodules: tree.entries.filter(e => e.type === 'commit').map(e => e.path), truncated: tree.truncated,
    }
  }
  catch (err) {
    githubErrorToHttp(err)
  }
})
