// Mailversand über SMTP (nodemailer, Konfiguration wie in Hajime-Pro). Ohne SMTP_HOST wird nur Empfänger + Betreff geloggt (keine Links).
import nodemailer from 'nodemailer';

export function createMailer(cfg, log = console) {
  let transporter = null;
  if (cfg.smtp.host) {
    transporter = nodemailer.createTransport({
      host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.password } : undefined,
    });
  }
  return {
    /** Wirft nie; Ergebnis { ok }. */
    async send({ to, subject, text }) {
      if (!transporter) {
        log.info?.(`[mail] SMTP nicht konfiguriert – nicht gesendet an ${to}: ${subject}`);
        return { ok: false, grund: 'kein_smtp' };
      }
      try {
        await transporter.sendMail({ from: cfg.smtp.from, to, subject, text });
        return { ok: true };
      } catch (e) {
        log.error?.(`[mail] Versand an ${to} fehlgeschlagen: ${e.message}`);
        return { ok: false, grund: 'fehler' };
      }
    },
  };
}
