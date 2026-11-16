/** Email via SMTP (STARTTLS exigé hors développement, certificat vérifié). */
import { readFileSync } from 'node:fs'
import nodemailer, { type Transporter } from 'nodemailer'
import { emailConfig } from '../../../shared/schemas/notifications'
import { env } from '../../utils/env'
import { type NotificationAdapter, type NotificationMessage, NotificationError } from './types'

let transport: Transporter | undefined

export function smtpConfigured(): boolean {
  return !!env().SMTP_HOST
}

function transporter(): Transporter {
  const e = env()
  if (!e.SMTP_HOST) throw new NotificationError('SMTP non configuré (SMTP_HOST)', false)
  transport ??= nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_SECURE,
    requireTLS: !e.SMTP_SECURE && e.NODE_ENV === 'production',
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD_FILE ? readFileSync(e.SMTP_PASSWORD_FILE, 'utf8').trim() : '' } : undefined,
    connectionTimeout: e.NOTIFY_TIMEOUT_MS,
    socketTimeout: e.NOTIFY_TIMEOUT_MS,
  })
  return transport
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!)
const COLOR = { info: '#2563eb', warning: '#b45309', error: '#b91c1c' } as const

export function renderEmail(m: NotificationMessage): { subject: string, text: string, html: string } {
  const text = [m.summary, '', ...m.facts.map(f => `${f.label} : ${f.value}`), ...(m.link ? ['', m.link] : [])].join('\n')
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111">
<h2 style="margin:0 0 8px;font-size:17px;color:${COLOR[m.severity]}">${esc(m.title)}</h2>
<p style="margin:0 0 12px;white-space:pre-wrap">${esc(m.summary)}</p>
<table style="border-collapse:collapse">${m.facts.map(f => `<tr><td style="padding:2px 12px 2px 0;color:#555">${esc(f.label)}</td><td style="padding:2px 0">${esc(f.value)}</td></tr>`).join('')}</table>
${m.link ? `<p style="margin-top:16px"><a href="${esc(m.link)}">Ouvrir dans la plateforme</a></p>` : ''}
</div>`
  return { subject: `[Plateforme] ${m.title}`, text, html }
}

/** Envoi direct à une adresse (ex. invitation). */
export async function sendMail(to: string[], subject: string, text: string, html?: string) {
  try {
    await transporter().sendMail({ from: env().SMTP_FROM, to, subject, text, html })
  }
  catch (err) {
    if (err instanceof NotificationError) throw err
    throw new NotificationError(`Envoi SMTP impossible : ${(err as Error).message}`)
  }
}

export const emailAdapter: NotificationAdapter = {
  kind: 'email',
  async send(config, message) {
    const { recipients } = emailConfig.parse(config)
    const mail = renderEmail(message)
    await sendMail(recipients, mail.subject, mail.text, mail.html)
  },
}
