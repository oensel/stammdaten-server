import { inTransaktion } from '../../db.js';
import { conflict, fehler, notFound } from '../../errors.js';
import * as audit from '../audit/dienst.js';
import { beendeDirektrechte, verlange } from '../rechte/dienst.js';
import * as daten from './daten.js';

/** FR-14: eigene Zugehörigkeit zu einem Verein anfragen. Rechte wirken erst nach der Freigabe. */
export function zugehoerigkeitAnfragen(ctx, db, { verein_id }) {
  if (!ctx.benutzer) throw notFound();
  return inTransaktion(db, async (c) => {
    let neu;
    try {
      neu = await daten.anfragen(c, { benutzerId: ctx.benutzer.id, vereinId: verein_id });
    } catch (e) {
      if (e.code === '23503') throw notFound(); // Verein gibt es nicht
      throw e;
    }
    if (!neu) throw conflict('Die Zugehörigkeit besteht oder ist schon angefragt', 'zugehoerigkeit_vorhanden');
    await beendeDirektrechte(ctx, c, { benutzer_id: ctx.benutzer.id, verein_id });
    return neu;
  });
}

export async function zugehoerigkeitenLesen(ctx, db, { verein_id, status = null }) {
  verlange(ctx, 'zugehoerigkeit:LESEN', { verein_id });
  return { zugehoerigkeiten: await daten.liste(db, { vereinId: verein_id, status }) };
}

// Entscheidung → [erlaubte Ausgangsstatus, neuer Status, Audit-Aktion]
const ENTSCHEIDUNGEN = {
  freigeben: [['angefragt', 'abgelehnt', 'gesperrt'], 'freigegeben', 'recht_vergeben'],
  ablehnen: [['angefragt'], 'abgelehnt', 'recht_entzogen'],
  entziehen: [['freigegeben'], 'gesperrt', 'recht_entzogen'],
};

export function zugehoerigkeitEntscheiden(ctx, db, { verein_id, id, version, entscheidung, grund = null }) {
  verlange(ctx, 'zugehoerigkeit:AENDERN', { verein_id });
  const [erlaubt, status, aktion] = ENTSCHEIDUNGEN[entscheidung];
  return inTransaktion(db, async (c) => {
    const alt = await daten.sperren(c, { id, vereinId: verein_id });
    if (!alt) throw notFound();
    if (alt.change_seq !== version) throw fehler(412, 'Der Datensatz wurde inzwischen geändert', 'version_veraltet');
    if (alt.benutzer_id === ctx.benutzer.id || alt.ist_super_admin) throw conflict('Dieses Konto ist geschützt', 'konto_geschuetzt');
    if (!erlaubt.includes(alt.status)) throw conflict('In diesem Status nicht möglich', 'status_unzulaessig');
    // Freigabe gibt immer nur Mitglied; weitere Rechte vergibt der Admin danach ausdrücklich
    await beendeDirektrechte(ctx, c, { benutzer_id: alt.benutzer_id, verein_id });
    const neu = await daten.entscheiden(c, { id, status, rolle: 'mitglied', von: ctx.benutzer.id, jetzt: ctx.jetzt });
    const bild = ({ rolle, status: s }) => ({ benutzer_id: alt.benutzer_id, verein_id, rolle, status: s });
    await audit.schreiben(ctx, c, { aktion, objekt_art: 'vereinszugehoerigkeit', objekt_id: id, alt: bild(alt), neu: bild(neu), grund });
    return neu;
  });
}
