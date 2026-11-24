import { tx, verlangeTransaktion } from '../../db.js';
import { ARTEN } from './arten.js';
import * as daten from './daten.js';

export const MAX_VERSUCHE = 5;
const WARTEN_MIN = [5, 15, 60, 240];

/**
 * Legt je Empfänger eine In-App-Nachricht und (mit E-Mail) einen Mail-Auftrag in der Transaktion des Aufrufers an.
 * `empfaenger`: [{ benutzer_id, email }] – die Adresse liefert der Aufrufer, dieses Blattmodul liest keine fremden Tabellen.
 */
export async function senden(ctx, db, { empfaenger, art, daten: inhalt }) {
  verlangeTransaktion(db, 'benachrichtigung.senden');
  if (!Object.hasOwn(ARTEN, art)) throw new Error(`Unbekannte Benachrichtigungsart: ${art}`);
  const { titel, text } = ARTEN[art](inhalt);
  for (const { benutzer_id, email } of empfaenger) {
    await daten.nachrichtAnlegen(db, { benutzer_id, art, titel, text, jetzt: ctx.jetzt });
    if (email) await daten.mailAnlegen(db, { an: email, betreff: titel, text, jetzt: ctx.jetzt });
  }
}

/** Job: versendet fällige Mail-Aufträge über den Mail-Port `mailer.send()`. Je Mail eine Transaktion (mindestens einmal). */
export async function versendeMails(ctx, db, { mailer, limit = 100 }) {
  let gesendet = 0;
  for (let i = 0; i < limit; i++) {
    const weiter = await tx(db, async (c) => {
      const m = await daten.naechsteOffeneMail(c, ctx.jetzt);
      if (!m) return false;
      const r = await mailer.send({ to: m.an, subject: m.betreff, text: m.text });
      if (r.ok) {
        await daten.mailGesendet(c, m.id, ctx.jetzt);
        gesendet++;
        return true;
      }
      if (r.grund === 'kein_smtp') return false; // nicht eingerichtet: Aufträge bleiben unverändert offen
      const status = m.versuche + 1 >= MAX_VERSUCHE ? 'fehlgeschlagen' : 'offen';
      const warten = WARTEN_MIN[m.versuche] ?? WARTEN_MIN.at(-1);
      await daten.mailFehlgeschlagen(c, m.id, { status, naechster: new Date(ctx.jetzt.getTime() + warten * 60_000) });
      return true;
    });
    if (!weiter) break;
  }
  return { gesendet };
}
