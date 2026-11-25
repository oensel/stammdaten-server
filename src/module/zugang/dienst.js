import { inTransaktion } from '../../db.js';
import { conflict, fehler, notFound, tooMany, unauthorized } from '../../errors.js';
import { hashSecret, neueBackupCodes, neuesGeheimnis, neuesToken, otpauthUri, pruefeCode, pruefeNeuesPasswort, sha256, startpasswort, verifyDummy, verifySecret } from '../../passwords.js';
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
  // Super-Admins gehen nicht über diesen Weg: er kennt keinen zweiten Faktor und würde ihr Passwort bestätigen
  if (!konto || konto.ist_super_admin) { await verifyDummy(passwort); throw falsch(); }
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
    const qr = await daten.qrAnlegen(c, { vereinId: verein_id, hash: sha256(token), von: ctx.benutzer.id, jetzt: ctx.jetzt, ablauf }).catch((e) => {
      throw e.constraint === 'qr_verein_aufgeloest' ? conflict('Der Verein ist aufgelöst', 'verein_aufgeloest') : e;
    });
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

// ---- Zweiter Faktor des Super-Admins (Story 2.9, NFR-16) ----
export const mfaBenutzerLesen = (ctx, db, { id }) => daten.mfaBenutzer(db, { id, jetzt: ctx.jetzt });

/** Gültiger Code (TOTP, jeder Zeitschritt nur einmal) oder unbenutzter Backup-Code, der dabei verbraucht wird. */
export async function zweitenFaktorPruefen(ctx, db, { id, eingabe, entschluesseln }) {
  const roh = eingabe ? await daten.totpGeheimnisLesen(db, id) : null;
  if (!roh) return false;
  const schritt = pruefeCode(entschluesseln(roh), eingabe, ctx.jetzt);
  if (schritt !== null) return daten.totpSchrittVerbrauchen(db, { id, schritt });
  return daten.backupCodeVerbrauchen(db, { id, hash: sha256(eingabe.trim().toLowerCase()), jetzt: ctx.jetzt });
}

/** Neue Backup-Codes; die alten verfallen sofort. Nur im Klartext in der Antwort. */
export async function backupCodesErneuern(ctx, db, { id }) {
  const codes = neueBackupCodes();
  await inTransaktion(db, async (c) => {
    await daten.backupCodesErsetzen(c, { id, hashes: codes.map(sha256) });
    await daten.sperreAufheben(c, id);
  });
  return codes;
}

export async function totpEinrichten(ctx, db, { id, benutzername, verschluesseln }) {
  const geheimnis = neuesGeheimnis();
  await daten.totpGeheimnisSetzen(db, { id, wert: verschluesseln(geheimnis) });
  return { geheimnis, otpauth_uri: otpauthUri(geheimnis, benutzername, 'Stammdaten') };
}

/** Prüft den Bestätigungscode; bei Erfolg aktiv, mit zehn Backup-Codes (nur hier im Klartext). Sonst null (Aufrufer zählt den Fehlversuch). */
export async function totpBestaetigen(ctx, db, { id, eingabe, entschluesseln }) {
  const roh = await daten.totpGeheimnisLesen(db, id);
  if (!roh) throw conflict('Zuerst die Einrichtung starten', 'einrichtung_nicht_gestartet');
  const schritt = pruefeCode(entschluesseln(roh), eingabe, ctx.jetzt);
  if (schritt === null) return null;
  const codes = neueBackupCodes();
  await inTransaktion(db, async (c) => {
    if (!await daten.totpAktivieren(c, { id, schritt, wert: roh, jetzt: ctx.jetzt })) throw conflict('Die Einrichtung wurde inzwischen geändert', 'zweiter_faktor_vorhanden');
    await daten.backupCodesErsetzen(c, { id, hashes: codes.map(sha256) });
    await daten.sperreAufheben(c, id);
  });
  return codes;
}

// ---- Konto für eine Person und Bestätigung (Story 3.5) ----
/** Legt ein Konto mit Startpasswort an; die Rechte prüft der Aufrufer. In dessen Transaktion. */
export async function kontoFuerPersonAnlegen(ctx, c, { benutzername, vorname, nachname, verein_id, mitglied_id }) {
  const start = startpasswort();
  try {
    const { id } = await daten.kontoAnlegen(c, { benutzername, vorname, nachname, hash: await hashSecret(start), von: ctx.benutzer.id });
    const z = await daten.zugehoerigkeitAnlegen(c, { benutzerId: id, vereinId: verein_id, mitgliedId: mitglied_id, von: ctx.benutzer.id, jetzt: ctx.jetzt });
    await audit.schreiben(ctx, c, { aktion: 'recht_vergeben', objekt_art: 'vereinszugehoerigkeit', objekt_id: z.id, neu: { benutzer_id: id, verein_id, rolle: 'mitglied', status: 'freigegeben' } });
    return { benutzer_id: id, benutzername, startpasswort: start };
  } catch (e) {
    if (e.constraint === 'benutzer_benutzername_uq') throw conflict('Benutzername schon vergeben', 'schon_vorhanden');
    if (e.code === '23505') throw conflict('Diese Person hat schon ein Konto', 'konto_vorhanden');
    throw e;
  }
}

/** { fremd_von, eigene, eltern }: nur Adressen, die vor der Fremdvergabe bestätigt waren bzw. von selbst nicht fremd vergebenen Konten. */
export async function bestaetigungsAdresse(ctx, db, { benutzer_id, eltern_ids }) {
  const u = await daten.fremdVergabe(db, benutzer_id);
  return u && { fremd_von: u.fremd_vergeben_von, eigene: u.eigene, eltern: await daten.sichereAdressen(db, eltern_ids) };
}

export async function bestaetigungAnlegen(ctx, c, { benutzer_id }) {
  const token = neuesToken();
  await daten.kontoSperren(c, benutzer_id);
  if (await daten.bestaetigungenSeit(c, { id: benutzer_id, seit: new Date(ctx.jetzt.getTime() - 3_600_000) }) >= 3) throw tooMany('Zu viele Bestätigungslinks – bitte später erneut');
  await daten.bestaetigungAnlegen(c, { id: benutzer_id, hash: sha256(token), jetzt: ctx.jetzt, ablauf: new Date(ctx.jetzt.getTime() + 48 * 3_600_000) });
  return token;
}

/** Öffentlich: der Link beweist den Zugang zur Adresse. */
export const kontoBestaetigen = (ctx, db, { token }) => inTransaktion(db, async (c) => {
  const b = await daten.bestaetigungVerbrauchen(c, { hash: sha256(token), jetzt: ctx.jetzt });
  if (!b || !await daten.fremdVergabeAufheben(c, b)) throw notFound('Link ungültig oder abgelaufen');
  await audit.schreiben(ctx, c, { aktion: 'recht_vergeben', objekt_art: 'konto', objekt_id: b.benutzer_id, neu: { bestaetigt: true } });
  return { ok: true };
});
