import { verlangeTransaktion } from '../../db.js';
import { ARTEN } from './arten.js';
import * as daten from './daten.js';

export const MAX_VERSUCHE = 5;
const WARTEN_MIN = [5, 15, 60, 240];

/**
 * Legt je Empfänger eine In-App-Nachricht und einen Mail-Auftrag in der Transaktion des Aufrufers an.
 * `empfaenger`: [{ benutzer_id }]; die Mail-Adresse wird erst beim Versand aufgelöst.
 */
export async function senden(ctx, db, { empfaenger, art, daten: inhalt }) {
  verlangeTransaktion(db, 'benachrichtigung.senden');
  if (!Object.hasOwn(ARTEN, art)) throw new Error(`Unbekannte Benachrichtigungsart: ${art}`);
  const { titel, text } = ARTEN[art](inhalt);
  for (const { benutzer_id } of empfaenger) {
    await daten.nachrichtAnlegen(db, { benutzer_id, art, titel, text, jetzt: ctx.jetzt });
    await daten.mailAnlegen(db, { benutzer_id, betreff: titel, text, jetzt: ctx.jetzt });
  }
}

const RESERVIERUNG_MIN = 15; // länger als jeder SMTP-Versuch; nach einem Absturz wird danach erneut versucht

/**
 * Job: versendet fällige Mail-Aufträge über den Mail-Port `mailer.send()`; `adresseVon(db, benutzer_id)` liefert die aktuelle
 * Adresse oder null (dann ist der Auftrag endgültig fehlgeschlagen, die In-App-Nachricht bleibt). Während des Versands ist keine
 * Transaktion offen (sonst hielte sie den Abgleich auf). Mindestens einmal: ein Absturz nach dem Versand kann doppelt senden.
 */
export async function versendeMails(ctx, db, { mailer, adresseVon, limit = 100, abbruch = () => false }) {
  const in_ = (min) => new Date(ctx.jetzt.getTime() + min * 60_000);
  let gesendet = 0;
  for (let i = 0; i < limit && !abbruch(); i++) {
    const m = await daten.mailReservieren(db, { jetzt: ctx.jetzt, frist: in_(RESERVIERUNG_MIN) });
    if (!m) break;
    const an = m.an ?? await adresseVon(db, m.benutzer_id);
    if (!an) {
      await daten.mailFehlgeschlagen(db, m.id, { status: 'fehlgeschlagen', naechster: ctx.jetzt });
      continue;
    }
    const r = await mailer.send({ to: an, subject: m.betreff, text: m.text });
    if (r.ok) {
      await daten.mailGesendet(db, m.id, ctx.jetzt);
      gesendet++;
    } else if (r.grund === 'kein_smtp') { // nicht eingerichtet: Aufträge bleiben unverändert offen
      await daten.mailFreigeben(db, m.id, ctx.jetzt);
      break;
    } else {
      const status = m.versuche >= MAX_VERSUCHE ? 'fehlgeschlagen' : 'offen';
      await daten.mailFehlgeschlagen(db, m.id, { status, naechster: in_(WARTEN_MIN[m.versuche - 1] ?? WARTEN_MIN.at(-1)) });
    }
  }
  return { gesendet };
}
