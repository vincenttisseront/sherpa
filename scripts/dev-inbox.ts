/**
 * Boîte de réception de développement (§18) : serveur SMTP (1025) et récepteur
 * de webhooks Teams (18500), pour tester les notifications sans service réel.
 *   npm run dev:inbox
 * Messages reçus : http://localhost:18500/ (JSON) ; enregistrés dans .data/dev-inbox/.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { SMTPServer } from 'smtp-server'

if (process.env.NODE_ENV === 'production') throw new Error('Outil réservé au développement')
const DIR = join(process.cwd(), '.data/dev-inbox')
mkdirSync(DIR, { recursive: true })
const inbox: { at: string, channel: 'email' | 'teams', summary: string, file: string }[] = []

function store(channel: 'email' | 'teams', summary: string, content: string) {
  const at = new Date().toISOString()
  const file = join(DIR, `${at.replace(/[:.]/g, '-')}-${channel}.${channel === 'email' ? 'eml' : 'json'}`)
  writeFileSync(file, content)
  inbox.unshift({ at, channel, summary, file })
  console.info(`[${channel}] ${summary}`)
}

const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, session, cb) {
    let raw = ''
    stream.on('data', (c) => { raw += c })
    stream.on('end', () => {
      const subject = /^Subject: (.*)$/m.exec(raw)?.[1] ?? '(sans objet)'
      store('email', `${session.envelope.rcptTo.map(r => r.address).join(', ')} — ${subject}`, raw)
      cb()
    })
  },
})
smtp.listen(1025, '0.0.0.0', () => console.info('SMTP de développement : port 1025'))

createServer((req, res) => {
  if (req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try {
        const card = JSON.parse(body) as { attachments?: { content?: { body?: { text?: string }[] } }[] }
        store('teams', card.attachments?.[0]?.content?.body?.[0]?.text ?? '(carte)', JSON.stringify(card, null, 2))
        res.writeHead(202).end()
      }
      catch {
        res.writeHead(400).end('JSON attendu')
      }
    })
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(inbox, null, 2))
}).listen(18500, '0.0.0.0', () => console.info('Webhook Teams de développement : http://localhost:18500/teams (liste : GET /)'))
