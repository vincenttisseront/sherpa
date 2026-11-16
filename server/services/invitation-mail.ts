/** Envoi direct du lien d'invitation ou de réinitialisation à la personne concernée (si SMTP configuré). */
import { renderEmail, sendMail, smtpConfigured } from '../adapters/notifications/email'

export async function sendInvitationMail(to: { email: string, displayName: string }, url: string, expiresAt: Date, purpose: 'invite' | 'reset'): Promise<{ emailed: boolean, emailError: string | null }> {
  if (!smtpConfigured()) return { emailed: false, emailError: null }
  const expires = expiresAt.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })
  const mail = renderEmail({
    event: 'user.invited',
    severity: 'info',
    title: purpose === 'invite' ? 'Invitation à Sherpa' : 'Réinitialisation de votre mot de passe',
    summary: purpose === 'invite'
      ? `Bonjour ${to.displayName},\n\nUn compte a été créé pour vous. Utilisez le lien ci-dessous pour choisir votre mot de passe.`
      : `Bonjour ${to.displayName},\n\nUne réinitialisation de votre mot de passe a été demandée par un administrateur. Utilisez le lien ci-dessous.`,
    facts: [{ label: 'Valable jusqu\'au', value: expires }],
    link: url,
  })
  try {
    await sendMail([to.email], mail.subject, `${mail.text}\n\nSi vous n'attendiez pas ce message, ignorez-le.`, mail.html)
    return { emailed: true, emailError: null }
  }
  catch (err) {
    return { emailed: false, emailError: (err as Error).message }
  }
}
