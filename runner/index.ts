import { z } from 'zod'
import { type RunnerConfig, loadRunnerConfig } from './config'
import { RUNNER_VERSION, createRunnerServer } from './server'

let config: RunnerConfig
try {
  config = loadRunnerConfig()
}
catch (err) {
  console.error(`Configuration du Runner invalide :\n${err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message}`)
  process.exit(1)
}

const server = createRunnerServer(config)
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} déjà utilisé : définir RUNNER_PORT` : `Démarrage impossible : ${err.message}`)
  process.exit(1)
})
server.listen(config.port, config.host, () => {
  console.info(`Target Runner ${RUNNER_VERSION} sur ${config.tls ? 'https' : 'http (INSECURE)'}://${config.host}:${config.port}, racines : ${config.roots.join(', ')}`)
})
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)))
