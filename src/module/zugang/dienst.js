import { inTransaktion } from '../../db.js';
import { conflict, fehler, notFound, tooMany, unauthorized } from '../../errors.js';
import { hashSecret, neuesToken, pruefeNeuesPasswort, sha256, verifyDummy, verifySecret } from '../../passwords.js';
import * as audit from '../audit/dienst.js';
import * as benachrichtigung from '../benachrichtigung/dienst.js';
import { beendeDirektrechte, ladeVerbandsrollen, verlangeAuf, wirksameBerechtigungen } from '../rechte/dienst.js';
import * as daten from './daten.js';

const MAX_OFFEN = 100; // offene Anfragen je Verein: begrenzt Missbrauch eines weitergegebenen Codes

/** Prüft den QR-Code in der Transaktion; liefert die Verein-ID. Unbekannt, abgelaufen und widerrufen sehen gleich aus. */
async function pruefeQr(ctx, c, token) {
  const qr = await daten.qrGueltig(c, { hash: sha256(token), jetzt: ctx.jetzt });
  if (!qr) throw notFound('QR-Code ungültig oder abgelaufen');
  if (await daten.offeneAnfragen(c, qr.verein_id) >= MAX_OFFEN) throw tooMany('Zu viele offene Anfragen in diesem Verein');
  return qr.verein_id;
}

async function anfrageAnlegen(ctx, c, { benutzer_id, verein_id }) {
  const neu = await daten.anfragen(c, { benutzerId: benutzer_id, vereinId: verein_id });
  if (!neu) throw conflict('Die Zugehörigkeit besteht oder ist schon angefragt', 'zugehoerigkeit_vorhanden');
  await beendeDirektrechte(ctx, c, { benutzer_id, verein_id });
  await daten.mitgliedsbezuegeBeenden(c, { benutzerId: benutzer_id, vereinId: verein_id, jetzt: ctx.jetzt });
  const n = await daten.benutzerName(c, benutzer_id);
  await benachrichtigung.senden(ctx, c, {
    empfaenger: await daten.vereinsAdmins(c, verein_id), art: 'zugehoerigkeit_angefragt',
    daten: { name: [n.vorname, n.nachname].filter(Boolean).join(' ') || n.benutzername },
  });
  return neu;
}

/** FR-14: ein bestehender Benutzer scannt den QR-Code eines Vereins. Rechte wirken erst nach der Freigabe. */
export const zugehoerigkeitAnfragen = (ctx, db, { token }) => inTransaktion(db, async (c) =>
  anfrageAnlegen(ctx, c, { benutzer_id: ctx.benutzer.id, verein_id: await pruefeQr(ctx, c, token) }));

/** Wie zugehoerigkeitAnfragen, für Konten ohne freigegebenen Verein: mit Passwort statt Token, stellt keine Sitzung aus. */
export async function anfragenMitPasswort(ctx, db, { token, benutzername, passwort, cfg }) {
  const falsch = () => unauthorized('Benutzername oder Passwort falsch', 'anmeldung_fehlgeschlagen');
  await inTransaktion(db, (c) => pruefeQr(ctx, c, token));
  const konto = await daten.kontoFuerAnmeldung(db, { kennung: benutzername.trim(), jetzt: ctx.jetzt });
  if (!konto) { await verifyDummy(passwort); throw falsch(); }
  if (konto.gesperrt) throw tooMany('Zu viele Fehlversuche – bitte später erneut versuchen');
  if (!await verifySecret(konto.passwort_hash, passwort)) {
    await daten.fehlversuch(db, { id: konto.id, max: cfg.maxFehlversuche, sperreBis: new Date(ctx.jetzt.getTime() + cfg.sperreMinuten * 60_000) });
    throw falsch();
  }
  return inTransaktion(db, async (c) => {
    await daten.fehlversucheZuruecksetzen(c, konto.id);
    const { verein_id, status } = await anfrageAnlegen(ctx, c, { benutzer_id: konto.id, verein_id: await pruefeQr(ctx, c, token) });
    return { verein_id, status };
  });
}

/**
 * Öffentliche Registrierung mit QR-Code. Ohne E-Mail: Eine ungeprüfte fremde Adresse würde dem Konto später deren Einladung
 * verschaffen. Die Anmeldung gelingt erst, wenn der Verein freigibt.
 */
export async function registrieren(ctx, db, { token, benutzername, vorname, nachname, passwort }) {
  pruefeNeuesPasswort(passwort, benutzername);
  await inTransaktion(db, (c) => pruefeQr(ctx, c, token)); // vor dem teuren Hash
  const hash = await hashSecret(passwort);
  try {
    return await inTransaktion(db, async (c) => {
      const verein_id = await pruefeQr(ctx, c, token);
      const { id } = await daten.benutzerAnlegen(c, { benutzername, vorname, nachname, hash });
      const { status } = await anfrageAnlegen(ctx, c, { benutzer_id: id, verein_id });
      return { benutzer_id: id, verein_id, status };
    });
  } catch (e) {
    if (e.constraint === 'benutzer_benutzername_uq') throw conflict('Benutzername schon vergeben', 'schon_vorhanden');
    throw e;
  }
}

export async function qrCodeAnlegen(ctx, db, { verein_id, gueltig_tage = 90 }) {
  await verlangeAuf(ctx, db, 'zugehoerigkeit:AENDERN', { vereine: [verein_id] });
  return inTransaktion(db, async (c) => {
    const token = neuesToken();
    const ablauf = new Date(ctx.jetzt.getTime() + gueltig_tage * 86_400_000);
    const qr = await daten.qrAnlegen(c, { vereinId: verein_id, hash: sha256(token), von: ctx.benutzer.id, jetzt: ctx.jetzt, ablauf });
    return { ...qr, token }; // nur hier im Klartext; den QR-Code zeichnet die Oberfläche
  });
}

export async function qrCodesLesen(ctx, db, { verein_id }) {
  await verlangeAuf(ctx, db, 'zugehoerigkeit:LESEN', { vereine: [verein_id] });
  return { qr_codes: await daten.qrListe(db, verein_id) };
}

export async function qrCodeWiderrufen(ctx, db, { verein_id, id }) {
  await verlangeAuf(ctx, db, 'zugehoerigkeit:AENDERN', { vereine: [verein_id] });
  const qr = await daten.qrWiderrufen(db, { id, vereinId: verein_id, jetzt: ctx.jetzt });
  if (!qr) throw notFound();
  return qr;
}

export async function zugehoerigkeitenLesen(ctx, db, { verein_id, status = null }) {
  await verlangeAuf(ctx, db, 'zugehoerigkeit:LESEN', { vereine: [verein_id] });
  return { zugehoerigkeiten: await daten.liste(db, { vereinId: verein_id, status }) };
}

// Entscheidung → [erlaubte Ausgangsstatus, neuer Status, Audit-Aktion]
const ENTSCHEIDUNGEN = {
  freigeben: [['angefragt', 'abgelehnt', 'gesperrt'], 'freigegeben', 'recht_vergeben'],
  ablehnen: [['angefragt'], 'abgelehnt', 'recht_entzogen'],
  entziehen: [['freigegeben'], 'gesperrt', 'recht_entzogen'],
};

export async function zugehoerigkeitEntscheiden(ctx, db, { verein_id, id, version, entscheidung, grund = null }) {
  await verlangeAuf(ctx, db, 'zugehoerigkeit:AENDERN', { vereine: [verein_id] });
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
    // Eine ältere Einladung darf die Entscheidung nicht wieder aufheben; eine spätere ist ein neuer Entschluss des Vereins
    if (status !== 'freigegeben') {
      const ziel = { benutzerId: alt.benutzer_id, vereinId: verein_id, jetzt: ctx.jetzt };
      await daten.einladungenVerbrauchen(c, ziel);
      await daten.mitgliedsbezuegeBeenden(c, ziel);
    }
    const bild = ({ rolle, status: s }) => ({ benutzer_id: alt.benutzer_id, verein_id, rolle, status: s });
    await audit.schreiben(ctx, c, { aktion, objekt_art: 'vereinszugehoerigkeit', objekt_id: id, alt: bild(alt), neu: bild(neu), grund });
    return neu;
  });
}

/** FR-16: Rechtedetails des aktiven Kontexts und wählbare Kontexte; das Token trägt nur die Kurzform. */
export async function ichLesen(ctx, db) {
  const verbaende = {};
  for (const r of await ladeVerbandsrollen(ctx, db, { benutzer_id: ctx.benutzer.id })) (verbaende[r.verband_id] ??= []).push(r.rolle);
  return {
    benutzer_id: ctx.benutzer.id, kontext: ctx.kontext, super_admin: ctx.rechte.super_admin,
    ...wirksameBerechtigungen(ctx),
    kontexte: {
      vereine: await daten.freigegebeneVereine(db, ctx.benutzer.id),
      verbaende: Object.entries(verbaende).map(([id, rollen]) => ({ id, rollen: rollen.sort() })),
    },
  };
}
