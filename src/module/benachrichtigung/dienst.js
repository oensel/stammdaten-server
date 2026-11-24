import { tx, verlangeTransaktion } from '../../db.js';
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

/**
 * Job: versendet fällige Mail-Aufträge über den Mail-Port `mailer.send()`; `adresseVon(db, benutzer_id)` liefert die aktuelle
 * Adresse oder null (dann ist der Auftrag endgültig fehlgeschlagen, die In-App-Nachricht bleibt). Je Mail eine Transaktion (mindestens einmal).
 */
export async function versendeMails(ctx, db, { mailer, adresseVon, limit = 100 }) {
  let gesendet = 0;
  for (let i = 0; i < limit; i++) {
    const weiter = await tx(db, async (c) => {
      const m = await daten.naechsteOffeneMail(c, ctx.jetzt);
      if (!m) return false;
      const an = m.an ?? await adresseVon(c, m.benutzer_id);
      if (!an) {
        await daten.mailFehlgeschlagen(c, m.id, { status: 'fehlgeschlagen', naechster: ctx.jetzt });
        return true;
      }
      const r = await mailer.send({ to: an, subject: m.betreff, text: m.text });
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
