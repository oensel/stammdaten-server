import { inTransaktion } from '../../db.js';
import { fehler, notFound } from '../../errors.js';
import * as audit from '../audit/dienst.js';
import * as daten from './daten.js';
import { darf, darfFelder, imKontext, listenbereich, projiziere, quellenImBereich } from './entscheidung.js';
import { filterEngerOderGleich } from './filter.js';
import { scopeFuer } from './obergrenze.js';
import { BASISRECHTE, KATALOG, kennt } from './katalog.js';

export { darf, darfFelder, listenbereich, projiziere };

/** Aktive Verbandsrollen eines Benutzers; die Pipeline lädt sie einmal in ctx.rechte.verbandsrollen (ctx ist dann noch null). */
export const ladeVerbandsrollen = (_ctx, db, { benutzer_id }) => daten.verbandsrollen(db, benutzer_id);

/** Benutzer mit einer aktiven Verbandsrolle in einem der Verbände: [{ benutzer_id }]. */
export const rollentraeger = (_ctx, db, { verband_ids, rolle }) => daten.rollentraeger(db, { verbandIds: verband_ids, rolle });

/** Beendet alle direkt vergebenen Rechte eines Benutzers in einem Verein (Entzug oder Neuanfrage der Zugehörigkeit). */
export async function beendeDirektrechte(ctx, db, { benutzer_id, verein_id }) {
  const ziel = { benutzerId: benutzer_id, vereinId: verein_id, von: ctx.benutzer?.id ?? null, jetzt: ctx.jetzt };
  await daten.direktrechteBeenden(db, ziel);
  await daten.vereinsrollenBeenden(db, ziel);
  await daten.erhalteneDelegationenBeenden(db, ziel);
  // Delegationen, die er gegeben hat, gelten bis zum Ablauf weiter, sind aber zu prüfen (Regel 4)
  await daten.delegationenVerwaisen(db, { geberId: benutzer_id, vereinId: verein_id, jetzt: ctx.jetzt });
}

/** Quellen des aktiven Kontexts; die Pipeline lädt sie einmal in ctx.rechte.quellen. Das Ist-Recht `pruefer` wird Lizenz, keine Rolle. */
export async function ladeQuellen(_ctx, db, { kontext, benutzerId, jetzt, rolle, rechte = [], verbandsrollen = [] }) {
  if (!kontext) return [];
  const art = kontext.art === 'verein' ? 'vereinsrolle' : 'verbandsrolle';
  const schluessel = art === 'vereinsrolle' ? [rolle, ...rechte.filter((r) => r !== 'pruefer')] : verbandsrollen.map((r) => r.rolle);
  // Stellvertreter haben die Rechte des Amts, aber kein DELEGIEREN
  const nurStv = new Set(verbandsrollen.filter((r) => r.stellvertreter_von).map((r) => r.rolle));
  for (const r of verbandsrollen) if (!r.stellvertreter_von) nurStv.delete(r.rolle);
  const ohneDelegieren = (r) => (nurStv.has(r.schluessel)
    ? { ...r, rechte: r.rechte.filter((x) => !x.endsWith(':DELEGIEREN')), filter: Object.fromEntries(Object.entries(r.filter).filter(([k]) => !k.endsWith(':DELEGIEREN'))) } : r);
  const eigene = art === 'vereinsrolle' && benutzerId ? await daten.eigeneRollenMitRechten(db, { benutzerId, vereinId: kontext.id }) : [];
  const rollen = [...(await daten.rollenMitRechten(db, [...new Set(schluessel)])).map(ohneDelegieren), ...eigene];
  const ebene = kontext.art === 'verband' ? EBENEN[await daten.ebene(db, kontext.id)] : undefined;
  const bereich = Object.freeze(ebene ? { ...kontext, ebene } : { ...kontext });
  // Delegierte Rechte (FR-22) gelten nur im Kontext ihres Bereichs und bis zum Ablaufdatum
  const delegiert = benutzerId && jetzt
    ? (await daten.delegationenAlsQuellen(db, { benutzerId, kontext, heute: jetzt.toISOString().slice(0, 10) }))
      .map((d) => ({ art: 'direkt', schluessel: 'delegation', rechte: [d.recht], bereich, filter: d.filter ? { [d.recht]: d.filter } : {} }))
    : [];
  return [
    ...rollen.map((r) => imKontext({ art, schluessel: r.schluessel, rechte: r.rechte, bereich, filter: r.filter }, kontext)),
    ...delegiert.map((q) => imKontext(q, kontext)),
  ].filter(Boolean).map(Object.freeze);
}
const EBENEN = { 1: 'dachverband', 2: 'landesverband', 3: 'bezirk', 4: 'kreis' };

/** Ergänzt ein Ziel um die Verbände über seinen Vereinen und Verbänden (verband_pfade). */
export async function ladeZiel(_ctx, db, ziel) {
  const ids = [...(ziel.vereine ?? []), ...(ziel.verbaende ?? []), ...(ziel.heimatverein_id ? [ziel.heimatverein_id] : [])];
  return { ...ziel, vorfahren: await daten.vorfahren(db, ids) };
}

/** Wirft 404 (nie 403), wenn darf() nein sagt. */
export function verlange(ctx, recht, ziel) {
  if (!darf(ctx, recht, ziel)) throw notFound();
}

/** Schreiben bestimmter Felder: kein Zugriff → 404, Zugriff aber unerlaubtes Feld → 422. */
export function verlangeFelder(ctx, recht, art, namen, ziel) {
  verlange(ctx, recht, ziel);
  if (!darfFelder(ctx, recht, art, namen, ziel)) throw fehler(422, 'Mindestens ein Feld darf nicht geändert werden', 'feld_nicht_erlaubt');
}

/** Wie verlange(), lädt vorher die Verbände über dem Ziel. */
export const verlangeAuf = async (ctx, db, recht, ziel) => verlange(ctx, recht, await ladeZiel(ctx, db, ziel));

/** Katalog der Rechte mit Operationen und Systemrollen (Super-Admin, Verbandsrollen, Vereins-Admins). */
export async function katalogLesen(ctx, db) {
  if (!ctx.rechte.super_admin && !ctx.rechte.verbandsrollen.length && ctx.rechte.rolle !== 'admin') throw notFound();
  return { rechte: KATALOG, rollen: await daten.systemrollen(db) };
}

/** Wirksame Rollenschlüssel und Berechtigungen im aktiven Kontext (FR-16). */
export function wirksameBerechtigungen(ctx) {
  const { quellen } = ctx.rechte;
  return { rollen: quellen.map((q) => q.schluessel).sort(), berechtigungen: [...new Set([...BASISRECHTE, ...quellen.flatMap((q) => q.rechte)])].sort() };
}

// ---- Verbandsrollen und Stellvertreter (FR-21, Story 2.6) ----
const VERSTOSS = {
  verbandsrolle_benutzer_unbekannt: [404, 'Benutzer nicht gefunden', 'benutzer_unbekannt'],
  verbandsrolle_verband_unbekannt: [404, 'Verband nicht gefunden', 'nicht_gefunden'],
  verbandsrolle_ebene_unzulaessig: [422, 'Diese Rolle ist in diesem Verband nicht vergebbar', 'rolle_nicht_vergebbar'],
  stellvertretung_ungueltig: [422, 'Stellvertreter gibt es nur für ein aktives Amt', 'stellvertretung_ungueltig'],
  stellvertreter_ist_amtsinhaber: [422, 'Der Amtsinhaber kann nicht sein eigener Stellvertreter sein', 'selbsternennung'],
  stellvertreter_hoechstens_zwei: [409, 'Ein Amt hat höchstens zwei Stellvertreter', 'stellvertreter_limit'],
  benutzer_verbandsrollen_uq: [409, 'Der Benutzer hat diese Rolle in diesem Verband schon', 'rolle_vergeben'],
};
async function schreibe(db, fn) {
  try {
    return await inTransaktion(db, fn);
  } catch (e) {
    const v = Object.hasOwn(VERSTOSS, e.constraint ?? '') && VERSTOSS[e.constraint];
    throw v ? fehler(...v) : e;
  }
}
// LV-Admins und DJB-Admins setzt nur der DJB-Admin oder der Super-Admin ein und ab
const OBERE = ['lv_admin', 'djb_admin'];
const hoehereBerechtigung = (ctx) => ctx.rechte.super_admin || ctx.rechte.quellen.some((q) => q.art === 'verbandsrolle' && q.schluessel === 'djb_admin');
const verlangeRolle = (ctx, rolle) => {
  if (OBERE.includes(rolle) && !hoehereBerechtigung(ctx)) throw fehler(422, 'Diese Rolle setzt nur der DJB-Admin ein', 'rolle_nicht_vergebbar');
};

export async function verbandsrollenLesen(ctx, db, { verband_id }) {
  await verlangeAuf(ctx, db, 'verbandsrolle:LESEN', { verbaende: [verband_id] });
  return { rollen: await daten.rollenImVerband(db, verband_id) };
}

export async function verbandsrolleVergeben(ctx, db, { verband_id, benutzer_id, rolle, grund = null }) {
  await verlangeAuf(ctx, db, 'verbandsrolle:ANLEGEN', { verbaende: [verband_id] });
  verlangeRolle(ctx, rolle);
  return schreibe(db, async (c) => {
    const neu = await daten.rolleEinfuegen(c, { benutzerId: benutzer_id, verbandId: verband_id, rolle, von: ctx.benutzer.id, grund, jetzt: ctx.jetzt });
    await audit.schreiben(ctx, c, { aktion: 'recht_vergeben', objekt_art: 'verbandsrolle', objekt_id: neu.id, neu, grund });
    return neu;
  });
}

export async function verbandsrolleEntziehen(ctx, db, { verband_id, id, grund = null }) {
  await verlangeAuf(ctx, db, 'verbandsrolle:LOESCHEN', { verbaende: [verband_id] });
  return schreibe(db, async (c) => {
    const alt = await daten.rolleSperren(c, { id, verbandId: verband_id });
    if (!alt || alt.stellvertreter_von) throw notFound();
    verlangeRolle(ctx, alt.rolle);
    const stv = await daten.stellvertreterAktiv(c, id);
    const ende = await daten.rolleBeenden(c, { id, von: ctx.benutzer.id, grund, jetzt: ctx.jetzt });
    await daten.delegationenVerwaisen(c, { geberId: alt.benutzer_id, schluessel: alt.rolle, jetzt: ctx.jetzt });
    await audit.schreiben(ctx, c, { aktion: 'recht_entzogen', objekt_art: 'verbandsrolle', objekt_id: id, alt: ende, grund });
    for (const s of stv) await audit.schreiben(ctx, c, { aktion: 'stellvertreter_entzogen', objekt_art: 'verbandsrolle', objekt_id: s.id, alt: { benutzer_id: s.benutzer_id, amt: id }, grund: 'Amt beendet' });
    return ende;
  });
}

/** Amtsinhaber (nur im Verbandskontext, nicht als Stellvertreter) oder wer Verbandsrollen vergeben darf. */
async function verlangeAmtsverwaltung(ctx, db, verband_id, amtId) {
  const ziel = await ladeZiel(ctx, db, { verbaende: [verband_id] });
  if (darf(ctx, 'verbandsrolle:ANLEGEN', ziel)) return;
  const eigene = ctx.kontext?.art === 'verband' && ctx.kontext.id === verband_id ? ctx.rechte.verbandsrollen : [];
  if (eigene.some((r) => r.id === amtId && !r.stellvertreter_von)) return;
  if (eigene.some((r) => r.stellvertreter_von === amtId)) throw fehler(422, 'Stellvertreter dürfen keine Stellvertreter ernennen', 'stellvertreter_darf_nicht_ernennen');
  throw notFound();
}

export async function stellvertreterErnennen(ctx, db, { verband_id, id, benutzer_id, grund }) {
  await verlangeAmtsverwaltung(ctx, db, verband_id, id);
  if (benutzer_id === ctx.benutzer.id) throw fehler(422, 'Selbsternennung ist nicht möglich', 'selbsternennung');
  try {
    return await schreibe(db, async (c) => {
      const amt = await daten.rolleSperren(c, { id, verbandId: verband_id });
      if (!amt || amt.stellvertreter_von) throw notFound();
      const neu = await daten.rolleEinfuegen(c, { benutzerId: benutzer_id, verbandId: verband_id, rolle: amt.rolle, stellvertreterVon: id, von: ctx.benutzer.id, grund, jetzt: ctx.jetzt });
      await audit.schreiben(ctx, c, { aktion: 'stellvertreter_ernannt', objekt_art: 'verbandsrolle', objekt_id: neu.id, neu, grund });
      return neu;
    });
  } catch (e) {
    // Der abgewiesene Versuch ist in einer eigenen Transaktion auditiert, die erste hat ihn verworfen
    if (e.code === 'stellvertreter_limit') {
      await inTransaktion(db, (c) => audit.schreiben(ctx, c, { aktion: 'stellvertreter_abgewiesen', objekt_art: 'verbandsrolle', objekt_id: id, neu: { benutzer_id, grund: e.code }, grund }));
    }
    throw e;
  }
}

export async function stellvertreterEntziehen(ctx, db, { verband_id, id, stellvertreter_id, grund }) {
  await verlangeAmtsverwaltung(ctx, db, verband_id, id);
  return schreibe(db, async (c) => {
    const alt = await daten.rolleSperren(c, { id: stellvertreter_id, verbandId: verband_id });
    if (!alt || alt.stellvertreter_von !== id) throw notFound();
    const ende = await daten.rolleBeenden(c, { id: stellvertreter_id, von: ctx.benutzer.id, grund, jetzt: ctx.jetzt });
    await audit.schreiben(ctx, c, { aktion: 'stellvertreter_entzogen', objekt_art: 'verbandsrolle', objekt_id: stellvertreter_id, alt: ende, grund });
    return ende;
  });
}

// ---- vereinseigene Rollen (FR-21, E98, Story 2.7) ----
Object.assign(VERSTOSS, {
  vereinsrolle_recht_nicht_erlaubt: [422, 'Dieses Recht ist in vereinseigenen Rollen nicht erlaubt', 'recht_nicht_erlaubt'],
  vereinsrolle_fremd: [404, 'Rolle nicht gefunden', 'nicht_gefunden'],
  vereinsrolle_kein_mitglied: [422, 'Der Benutzer gehört dem Verein nicht an', 'kein_vereinsmitglied'],
  benutzer_vereinsrollen_uq: [409, 'Der Benutzer hat diese Rolle schon', 'rolle_vergeben'],
  rollen_schluessel_uq: [409, 'Eine Rolle mit diesem Namen gibt es schon', 'name_vergeben'],
});

const kuerzel = (name) => `eigen_${name.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50)}`;

/** Jedes Recht muss im Katalog stehen und vom Vergebenden selbst gehalten und delegierbar sein; die Positivliste prüft die Datenbank. */
async function pruefeBerechtigungen(ctx, db, verein_id, berechtigungen) {
  const ziel = await ladeZiel(ctx, db, { vereine: [verein_id] });
  const erlaubt = await daten.positivliste(db);
  for (const b of berechtigungen) {
    if (!kennt(b)) throw fehler(422, `Unbekanntes Recht: ${b}`, 'recht_unbekannt');
    const [recht, operation] = b.split(':');
    if (operation === 'DELEGIEREN' || !erlaubt.includes(recht)) throw fehler(422, `Das Recht ${b} ist in vereinseigenen Rollen nicht erlaubt`, 'recht_nicht_erlaubt');
    if (!kennt(`${recht}:DELEGIEREN`) || !darf(ctx, b, ziel) || !darf(ctx, `${recht}:DELEGIEREN`, ziel)) throw fehler(422, `Das Recht ${b} darfst du nicht delegieren`, 'recht_nicht_delegierbar');
  }
}

export async function vereinsrollenLesen(ctx, db, { verein_id }) {
  await verlangeAuf(ctx, db, 'rolle:LESEN', { vereine: [verein_id] });
  return { rollen: await daten.vereinsrollenLesen(db, verein_id) };
}

export async function vereinsrolleAnlegen(ctx, db, { verein_id, name, berechtigungen }) {
  await verlangeAuf(ctx, db, 'rolle:ANLEGEN', { vereine: [verein_id] });
  await pruefeBerechtigungen(ctx, db, verein_id, berechtigungen);
  return schreibe(db, async (c) => {
    const rolle = await daten.vereinsrolleAnlegen(c, { vereinId: verein_id, schluessel: kuerzel(name), name });
    await daten.berechtigungenErsetzen(c, { rolleId: rolle.id, berechtigungen });
    return { ...rolle, berechtigungen: [...berechtigungen].sort(), vergeben: 0 };
  });
}

export async function vereinsrolleAendern(ctx, db, { verein_id, id, name, berechtigungen }) {
  await verlangeAuf(ctx, db, 'rolle:AENDERN', { vereine: [verein_id] });
  if (berechtigungen) await pruefeBerechtigungen(ctx, db, verein_id, berechtigungen);
  return schreibe(db, async (c) => {
    if (!await daten.vereinsrolleSperren(c, { id, vereinId: verein_id })) throw notFound();
    if (name) await daten.vereinsrolleUmbenennen(c, { id, name });
    if (berechtigungen) await daten.berechtigungenErsetzen(c, { rolleId: id, berechtigungen });
    return (await daten.vereinsrollenLesen(c, verein_id)).find((r) => r.id === id);
  });
}

export async function vereinsrolleLoeschen(ctx, db, { verein_id, id }) {
  await verlangeAuf(ctx, db, 'rolle:LOESCHEN', { vereine: [verein_id] });
  return schreibe(db, async (c) => {
    if (!await daten.vereinsrolleSperren(c, { id, vereinId: verein_id })) throw notFound();
    if (await daten.vereinsrolleVergeben(c, { rolleId: id, vereinId: verein_id })) throw fehler(409, 'Die Rolle ist vergeben und lässt sich nicht löschen', 'rolle_vergeben');
    await daten.vereinsrolleLoeschen(c, id);
    return { id, geloescht: true };
  });
}

export async function vereinsrolleZuweisen(ctx, db, { verein_id, id, benutzer_id }) {
  await verlangeAuf(ctx, db, 'rolle:AENDERN', { vereine: [verein_id] });
  return schreibe(db, async (c) => {
    if (!await daten.vereinsrolleSperren(c, { id, vereinId: verein_id })) throw notFound();
    const neu = await daten.vereinsrolleZuweisen(c, { benutzerId: benutzer_id, vereinId: verein_id, rolleId: id, von: ctx.benutzer.id, jetzt: ctx.jetzt });
    await audit.schreiben(ctx, c, { aktion: 'recht_vergeben', objekt_art: 'vereinsrolle', objekt_id: neu.id, neu });
    return neu;
  });
}

export async function vereinsrolleEntziehen(ctx, db, { verein_id, id, benutzer_id }) {
  await verlangeAuf(ctx, db, 'rolle:AENDERN', { vereine: [verein_id] });
  return schreibe(db, async (c) => {
    const alt = await daten.vereinsrolleEntziehen(c, { benutzerId: benutzer_id, vereinId: verein_id, rolleId: id, von: ctx.benutzer.id, jetzt: ctx.jetzt });
    if (!alt) throw notFound();
    await audit.schreiben(ctx, c, { aktion: 'recht_entzogen', objekt_art: 'vereinsrolle', objekt_id: alt.id, alt });
    return alt;
  });
}

// ---- Delegation (FR-22, E6, E102, Story 2.8) ----
Object.assign(VERSTOSS, {
  delegation_zu_lang: [422, 'Eine Delegation gilt höchstens zwei Jahre', 'frist_ungueltig'],
  delegation_kein_mitglied: [422, 'Der Empfänger gehört dem Verein nicht an', 'empfaenger_kein_mitglied'],
  delegation_benutzer_unbekannt: [404, 'Benutzer nicht gefunden', 'benutzer_unbekannt'],
  delegation_selbst: [422, 'Eine Delegation an sich selbst ist sinnlos', 'selbstdelegation'],
  keine_weiterdelegation: [422, 'Delegierte Rechte lassen sich nicht weitergeben', 'weiterdelegation'],
  delegieren_nur_super_admin: [422, 'DELEGIEREN vergibt nur der Super-Admin', 'delegieren_nur_super_admin'],
  delegation_ohne_quelle: [422, 'Ohne eigene Rolle als Quelle darf nur der Super-Admin vergeben', 'delegieren_nur_super_admin'],
  delegationen_recht_operation_fkey: [422, 'Unbekanntes Recht', 'recht_unbekannt'],
  delegationen_verein_id_fkey: [404, 'Verein nicht gefunden', 'nicht_gefunden'],
  delegationen_verband_id_fkey: [404, 'Verband nicht gefunden', 'nicht_gefunden'],
  delegationen_empfaenger_id_fkey: [404, 'Benutzer nicht gefunden', 'benutzer_unbekannt'],
});

const tag = (d) => d.toISOString().slice(0, 10);
const plusJahre = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + n); return tag(d); };
const bereichsZiel = ({ verein_id, verband_id }) => (verein_id ? { vereine: [verein_id] } : { verbaende: [verband_id] });
const bereichsFelder = ({ verein_id = null, verband_id = null }) => ({ vereinId: verein_id, verbandId: verband_id });

export async function delegationAnlegen(ctx, db, { empfaenger_id, recht, verein_id = null, verband_id = null, datenfilter = null, gueltig_bis, grund = null }) {
  if (!kennt(recht)) throw fehler(422, `Unbekanntes Recht: ${recht}`, 'recht_unbekannt');
  const [name, operation] = recht.split(':');
  const ziel = await ladeZiel(ctx, db, bereichsZiel({ verein_id, verband_id }));
  const von = tag(ctx.jetzt);
  if (gueltig_bis < von || gueltig_bis > plusJahre(von, 2)) throw fehler(422, 'Die Delegation muss befristet sein, höchstens zwei Jahre', 'frist_ungueltig');
  if (empfaenger_id === ctx.benutzer.id) throw fehler(422, 'Eine Delegation an sich selbst ist sinnlos', 'selbstdelegation');
  const filter = datenfilter ? await daten.datenfilterLesen(db, datenfilter) : null;
  if (datenfilter && !filter) throw fehler(422, 'Unbekannter Datenfilter', 'datenfilter_unbekannt');

  let quelle = null;
  if (operation === 'DELEGIEREN') {
    if (!ctx.rechte.super_admin) throw fehler(422, 'DELEGIEREN vergibt nur der Super-Admin', 'delegieren_nur_super_admin');
    if (!darf(ctx, recht, ziel)) throw notFound();
  } else if (ctx.rechte.super_admin) {
    if (!darf(ctx, recht, ziel)) throw notFound();
  } else {
    const delegieren = `${name}:DELEGIEREN`;
    if (!kennt(delegieren)) throw fehler(422, `${recht} lässt sich nicht delegieren`, 'recht_nicht_delegierbar');
    // Delegierte Rechte gelten nicht als Quelle (nur eine Ebene)
    const eigene = ctx.rechte.quellen.filter((q) => q.art !== 'direkt');
    if (!ctx.rechte.app_scopes.includes(scopeFuer(delegieren)) || !eigene.some((q) => q.rechte.includes(delegieren))) throw notFound();
    if (!darf(ctx, delegieren, ziel)) throw fehler(422, 'Der Bereich liegt außerhalb deines Bereichs', 'bereich_zu_weit');
    const quellen = quellenImBereich({ rechte: { quellen: eigene } }, recht, ziel);
    if (!quellen.length) throw fehler(422, `Du hast ${recht} in diesem Bereich nicht`, 'recht_nicht_delegierbar');
    const q = quellen.find((x) => filterEngerOderGleich(filter, x.filter?.[recht] ?? null));
    if (!q) throw fehler(422, 'Der Datenfilter ist weiter als dein eigener', 'filter_zu_weit');
    quelle = { art: q.art === 'lizenz' ? 'lizenz' : 'rolle', schluessel: q.schluessel };
  }
  return schreibe(db, async (c) => {
    const neu = await daten.delegationEinfuegen(c, {
      empfaengerId: empfaenger_id, geberId: ctx.benutzer.id, ...bereichsFelder({ verein_id, verband_id }), recht: name, operation,
      datenfilterId: filter?.id, von, bis: gueltig_bis, quelle, grund, jetzt: ctx.jetzt,
    });
    await audit.schreiben(ctx, c, { aktion: 'recht_vergeben', objekt_art: 'delegation', objekt_id: neu.id, neu, grund });
    return neu;
  });
}

/** Vereins-Admin bzw. Landesverbands-Admin der Ebene (oder Super-Admin). */
const adminRecht = (bereich) => (bereich.verein_id ? 'rolle:AENDERN' : 'verbandsrolle:LOESCHEN');
const darfAlsAdmin = async (ctx, db, bereich) => darf(ctx, adminRecht(bereich), await ladeZiel(ctx, db, bereichsZiel(bereich)));

export async function delegationenLesen(ctx, db, { verein_id = null, verband_id = null, verwaist = false }) {
  if (!verein_id === !verband_id) throw fehler(400, 'Genau einen Bereich angeben: verein_id oder verband_id', 'ungueltige_anfrage');
  if (!await darfAlsAdmin(ctx, db, { verein_id, verband_id })) throw notFound();
  return { delegationen: await daten.delegationenLesen(db, { vereinId: verein_id, verbandId: verband_id, nurVerwaist: verwaist }) };
}

const entzugAuditieren = async (ctx, c, ds, grund) => {
  for (const d of ds) await audit.schreiben(ctx, c, { aktion: 'recht_entzogen', objekt_art: 'delegation', objekt_id: d.id, alt: d, grund });
  return ds;
};

export async function delegationEntziehen(ctx, db, { id, grund = null }) {
  return schreibe(db, async (c) => {
    const alt = await daten.delegationSperren(c, id);
    if (!alt) throw notFound();
    if (alt.geber_id !== ctx.benutzer.id && !await darfAlsAdmin(ctx, c, alt)) throw notFound();
    const [ende] = await entzugAuditieren(ctx, c, await daten.delegationenBeenden(c, { id, von: ctx.benutzer.id, jetzt: ctx.jetzt }), grund);
    return ende;
  });
}

/** Alle verwaisten Delegationen eines Bereichs oder alle eines Gebers (z. B. bei Missbrauch) in einem Schritt entziehen. */
export async function delegationenEntziehen(ctx, db, { verein_id = null, verband_id = null, geber_id = null, verwaist = false, grund }) {
  if (!verein_id === !verband_id || (!geber_id && !verwaist)) throw fehler(400, 'Einen Bereich und geber_id oder verwaist angeben', 'ungueltige_anfrage');
  if (!await darfAlsAdmin(ctx, db, { verein_id, verband_id })) throw notFound();
  return schreibe(db, async (c) => {
    const ds = await daten.delegationenBeenden(c, { ...bereichsFelder({ verein_id, verband_id }), geberId: geber_id, nurVerwaist: verwaist, von: ctx.benutzer.id, jetzt: ctx.jetzt });
    await entzugAuditieren(ctx, c, ds, grund);
    return { entzogen: ds.length, delegationen: ds };
  });
}
