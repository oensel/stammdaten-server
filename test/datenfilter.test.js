// Story 2.5 (FR-23): Datenfilter
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verlangeFelder, ladeQuellen } from '../src/module/rechte/dienst.js';
import { darf, darfFelder, listenbereich, projiziere } from '../src/module/rechte/entscheidung.js';
import { gradRang } from '../src/module/rechte/filter.js';
import { baueCtx } from '../src/pipeline/ctx.js';
import { verbandsbaum } from './fabrik.js';
import { neueApp } from './helper.js';

const B = { art: 'verein', id: 'V1' };
const LEER = { nur_aktive: false, felder: null };
const quelle = (recht, filter, extra = {}) => ({ art: 'vereinsrolle', schluessel: 'x', rechte: [recht], bereich: B, filter: filter ? { [recht]: { ...LEER, ...filter } } : {}, ...extra });
const mit = (quellen, rechte = {}) => baueCtx({
  benutzer: { id: 'u' }, kontext: B, anwendung: 'a', jetzt: new Date(),
  rechte: { quellen, app_scopes: ['mitglieder:lesen', 'mitglieder:schreiben', null], ...rechte },
});
const ziel = (extra = {}) => ({ vereine: ['V1'], heimatverein_id: 'V1', ...extra });
const person = (p) => ziel({ person: { aktiv: true, rang: 5, lizenzen: [], ...p } });

it('Gürtelrang', () => {
  expect([['kyu', 9], ['kyu', 1], ['dan', 1], ['dan', 10], ['kyu', 10], ['dan', 11], ['kyu', 0], ['x', 1]].map(([art, stufe]) => gradRang({ art, stufe })))
    .toEqual([1, 9, 10, 19, null, null, null, null]);
});

describe('Subjektfilter', () => {
  const L = 'mitglieder:LESEN';
  it.each([
    [{ nur_aktive: true }, { aktiv: true }, true], [{ nur_aktive: true }, { aktiv: false }, false], [{ nur_aktive: true }, { aktiv: undefined }, false],
    [{ subjekt_min_rang: 5, subjekt_max_rang: 8 }, { rang: 5 }, true], [{ subjekt_min_rang: 5, subjekt_max_rang: 8 }, { rang: 8 }, true],
    [{ subjekt_min_rang: 5 }, { rang: 4 }, false], [{ subjekt_max_rang: 8 }, { rang: 9 }, false], [{ subjekt_min_rang: 1 }, { rang: null }, false],
    [{ subjekt_lizenz: 'judopass' }, { lizenzen: ['judopass'] }, true], [{ subjekt_lizenz: 'judopass' }, { lizenzen: ['trainer'] }, false],
    [{ nur_aktive: true, subjekt_min_rang: 5 }, { aktiv: false, rang: 9 }, false],
    [{}, { aktiv: false, rang: null }, true],
  ])('%o auf %o → %s', (f, p, erwartet) => { expect(darf(mit([quelle(L, f)]), L, person(p))).toBe(erwartet); });
  it('ohne Angaben zur Person ist ein Filter nie erfüllt', () => {
    expect(darf(mit([quelle(L, { nur_aktive: true })]), L, ziel())).toBe(false);
  });
});

describe('Wertfilter', () => {
  const A = 'mitglieder:AENDERN'; // steht hier für ein Recht mit Wert
  const pruefe = (f, werte, rechte) => darf(mit([quelle(A, f)], rechte), A, ziel({ werte }));
  const kyu = (stufe) => ({ art: 'kyu', stufe }); const dan = (stufe) => ({ art: 'dan', stufe });
  it('Spanne 8. bis 2. Kyu', () => {
    const f = { wert_art: 'kyu', wert_min_rang: 2, wert_max_rang: 8 };
    expect([9, 8, 2, 1].map((s) => pruefe(f, [kyu(s)]))).toEqual([false, true, true, false]);
    expect(pruefe(f, [dan(1)])).toBe(false);
    expect(pruefe(f, [])).toBe(false);
    expect(pruefe(f, undefined)).toBe(false);
  });
  it('beim Ändern zählen alter und neuer Wert', () => {
    expect(pruefe({ wert_max_rang: 8 }, [kyu(5), kyu(4)])).toBe(true);
    expect(pruefe({ wert_max_rang: 8 }, [kyu(1), kyu(4)])).toBe(false);
  });
  it('bis zum eigenen Grad; ohne eigenen Grad nie', () => {
    const f = { wert_art: 'dan', wert_bis_eigener_grad: true };
    expect([1, 2, 3].map((s) => pruefe(f, [dan(s)], { eigener_rang: gradRang(dan(2)) }))).toEqual([true, true, false]);
    expect(pruefe(f, [dan(1)])).toBe(false);
  });
  it('gilt nicht fürs Lesen', () => {
    expect(darf(mit([quelle('mitglieder:LESEN', { wert_max_rang: 8 })]), 'mitglieder:LESEN', ziel())).toBe(true);
  });
});

describe('Feldfilter', () => {
  const daten = { id: 'p', vorname: 'A', geburtsdatum: null, email: null, telefon: '1' };
  const L = 'mitglieder:LESEN'; const A = 'mitglieder:AENDERN';
  it('nicht erlaubte Felder fehlen, erlaubte leere bleiben leer', () => {
    expect(projiziere(mit([quelle(L, { felder: ['stamm'] })]), 'person', daten, ziel())).toEqual({ id: 'p', vorname: 'A', geburtsdatum: null });
    expect(projiziere(mit([quelle(L, { felder: ['vorname', 'email'] })]), 'person', daten, ziel())).toEqual({ vorname: 'A', email: null });
    expect(projiziere(mit([quelle(L, { felder: [] })]), 'person', daten, ziel())).toEqual({});
  });
  it('Verbandsrollen sehen Kontakt auch ohne oder trotz Filter nicht', () => {
    const verband = { art: 'verbandsrolle', bereich: { art: 'verband', id: 'L1', ebene: 'landesverband' } };
    for (const f of [null, { felder: ['stamm', 'kontakt', 'email'] }]) {
      expect(projiziere(mit([quelle(L, f, verband)]), 'person', daten, ziel({ vorfahren: { V1: ['L1'] } }))).toEqual({ id: 'p', vorname: 'A', geburtsdatum: null });
    }
  });
  it('Schreiben auf nicht erlaubte oder unbekannte Felder wird abgelehnt', () => {
    const ctx = mit([quelle(A, { felder: ['vorname', 'nachname'] })]);
    expect(darfFelder(ctx, A, 'person', ['vorname'], ziel())).toBe(true);
    expect(darfFelder(ctx, A, 'person', ['vorname', 'email'], ziel())).toBe(false);
    expect(darfFelder(mit([quelle(A)]), A, 'person', ['passwort_hash'], ziel())).toBe(false);
    expect(() => verlangeFelder(ctx, A, 'person', ['email'], ziel())).toThrow(expect.objectContaining({ status: 422, code: 'feld_nicht_erlaubt' }));
    expect(() => verlangeFelder(ctx, A, 'person', ['vorname'], ziel({ vereine: ['V2'] }))).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('Quellen werden nie kombiniert', () => {
  const L = 'mitglieder:LESEN'; const A = 'mitglieder:AENDERN';
  it('Rang aus der einen und Aktivität aus der anderen Quelle reichen nicht', () => {
    const ctx = mit([quelle(L, { subjekt_min_rang: 9 }), quelle(L, { nur_aktive: true, subjekt_max_rang: 3 })]);
    expect(darf(ctx, L, person({ aktiv: true, rang: 5 }))).toBe(false);
    expect(darf(ctx, L, person({ aktiv: false, rang: 9 }))).toBe(true);
    expect(darf(ctx, L, person({ aktiv: true, rang: 2 }))).toBe(true);
  });
  it('zwei Quellen erlauben zusammen kein Schreiben, das keine allein erlaubt', () => {
    const ctx = mit([quelle(A, { felder: ['vorname'] }), quelle(A, { felder: ['email'] })]);
    expect(darfFelder(ctx, A, 'person', ['vorname', 'email'], ziel())).toBe(false);
  });
  it('Felder einer Quelle, deren Filter die Person ausschließt, erscheinen nicht', () => {
    const ctx = mit([quelle(L, { felder: ['vorname'] }), quelle(L, { felder: ['email'], subjekt_min_rang: 9 })]);
    expect(projiziere(ctx, 'person', { vorname: 'A', email: 'e' }, person({ rang: 5 }))).toEqual({ vorname: 'A' });
  });
  it('Listen führen gefilterte Quellen einzeln, nicht als freien Bereich', () => {
    const l = listenbereich(mit([quelle(L, { nur_aktive: true })]), L);
    expect(l).toMatchObject({ alle: false, vereine: [], verbaende: [], gefiltert: [{ bereich: B, filter: { nur_aktive: true } }] });
    expect(listenbereich(mit([quelle(L, { felder: ['stamm'] })]), L)).toMatchObject({ vereine: ['V1'], gefiltert: [] });
  });
});

describe('Seed', () => {
  let t; let baum;
  beforeAll(async () => { t = await neueApp(); baum = await verbandsbaum(t.pool); });
  afterAll(() => t.schliessen());
  const filterVon = async (rolle, kontext) => {
    const q = kontext.art === 'verein' ? { kontext, rolle } : { kontext, verbandsrollen: [{ rolle, verband_id: kontext.id }] };
    const [x] = await ladeQuellen(null, t.pool, q);
    return Object.fromEntries(Object.entries(x.filter).map(([k, f]) => [k, f.schluessel]));
  };
  it('die Seed-Matrix trägt ihre Filter', async () => {
    const vb = (id) => ({ art: 'verband', id });
    const pruefung = (f) => Object.fromEntries(['LESEN', 'ANLEGEN', 'AENDERN', 'LOESCHEN'].map((o) => [`pruefung:${o}`, f]));
    expect(await filterVon('trainer', { art: 'verein', id: baum.verein })).toEqual({ 'mitglieder:LESEN': 'ohne_kontakt', ...pruefung('pruefung_8_bis_2_kyu') });
    expect(await filterVon('admin', { art: 'verein', id: baum.verein })).toEqual({});
    expect(await filterVon('kreis_dan_vorsitzender', vb(baum.kreis))).toEqual({
      'mitglieder:LESEN': 'ab_2_kyu_ohne_kontakt', 'graduierung:LESEN': 'ab_2_kyu', ...pruefung('pruefung_1_kyu'), 'pruefung_abnahme:AENDERN': 'pruefung_1_kyu', 'pruefung_abschluss:AENDERN': 'pruefung_1_kyu' });
    expect(await filterVon('bezirks_dan_beauftragter', vb(baum.bezirk))).toEqual({ 'mitglieder:LESEN': 'ab_1_kyu_ohne_kontakt', 'graduierung:LESEN': 'ab_1_kyu' });
    expect(await filterVon('landesvertreter', vb(baum.lv))).toEqual({ 'mitglieder:LESEN': 'alle_ohne_kontakt', 'mitglieder:AENDERN': 'judopassfelder' });
    expect(await filterVon('dan_pruefungsorganisation', vb(baum.lv))).toEqual(pruefung('pruefung_dan'));
  });
  it('Bezirks-Dan-Beauftragte sehen nur aktive Mitglieder ab 1. Kyu', async () => {
    const kontext = { art: 'verband', id: baum.bezirk };
    const quellen = await ladeQuellen(null, t.pool, { kontext, verbandsrollen: [{ rolle: 'bezirks_dan_beauftragter', verband_id: baum.bezirk }] });
    const ctx = baueCtx({ benutzer: { id: 'u' }, kontext, anwendung: 'a', jetzt: new Date(), rechte: { quellen, app_scopes: ['mitglieder:lesen', 'graduierungen:lesen'] } });
    const auf = (aktiv, rang) => ({ vereine: [baum.verein], vorfahren: { [baum.verein]: [baum.kreis, baum.bezirk] }, person: { aktiv, rang, lizenzen: [] } });
    for (const recht of ['mitglieder:LESEN', 'graduierung:LESEN']) {
      expect([auf(true, 9), auf(true, 8), auf(false, 9), auf(false, 12)].map((z) => darf(ctx, recht, z))).toEqual([true, false, false, false]);
    }
  });
  it('ungültige Filter nimmt die Datenbank nicht an', async () => {
    await expect(t.pool.query(`insert into datenfilter (schluessel, name, subjekt_min_rang, subjekt_max_rang) values ('x', 'x', 9, 2)`)).rejects.toThrow('check');
  });
});
