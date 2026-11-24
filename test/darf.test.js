// Story 2.4 (FR-24, NFR-1, NFR-2, SYS-UNIT-001, SYS-INT-001)
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imKontext, darf, listenbereich, projiziere } from '../src/module/rechte/entscheidung.js';
import { baueCtx, systemCtx } from '../src/pipeline/ctx.js';
import { gibRolle, verbandsbaum, verbandsToken, verein } from './fabrik.js';
import { neueApp } from './helper.js';

// Baum: DJB > LV1 > K1 > V1 und DJB > LV2 > K2 > V2
const vorfahren = { V1: ['K1', 'LV1', 'DJB'], V2: ['K2', 'LV2', 'DJB'], LV1: ['LV1', 'DJB'], K1: ['K1', 'LV1', 'DJB'] };
const auf = (v, extra = {}) => ({ vereine: [v], heimatverein_id: v, vorfahren, ...extra });
const B = { V1: { art: 'verein', id: 'V1' }, LV1: { art: 'verband', id: 'LV1', ebene: 'landesverband' }, K1: { art: 'verband', id: 'K1', ebene: 'kreis' }, DJB: { art: 'verband', id: 'DJB', ebene: 'dachverband' } };
const quelle = (bereich, rechte, art = bereich.art === 'verein' ? 'vereinsrolle' : 'verbandsrolle', felder = art === 'verbandsrolle' ? ['stamm'] : null) => ({ art, schluessel: 'x', rechte, bereich, felder });
const mit = (...quellen) => baueCtx({ benutzer: { id: 'u' }, kontext: { art: 'verein', id: 'V1' }, anwendung: 'a', jetzt: new Date(), rechte: { quellen, scopes: ['benutzer:verwalten'] } });

describe('darf(): Bereich × Quelle × Recht', () => {
  it.each([
    // Bereich, Recht der Quelle, gefragtes Recht, Ziel, erwartet
    ['V1', 'mitglieder:LESEN', 'mitglieder:LESEN', auf('V1'), true],
    ['V1', 'mitglieder:LESEN', 'mitglieder:LESEN', auf('V2'), false],
    ['V1', 'mitglieder:LESEN', 'mitglieder:AENDERN', auf('V1'), false],
    ['K1', 'mitglieder:LESEN', 'mitglieder:LESEN', auf('V1'), true],
    ['LV1', 'mitglieder:LESEN', 'mitglieder:LESEN', auf('V1'), true],
    ['LV1', 'mitglieder:LESEN', 'mitglieder:LESEN', auf('V2'), false],
    ['DJB', 'mitglieder:LESEN', 'mitglieder:LESEN', auf('V2'), true],
    ['LV1', 'fristen:AENDERN', 'fristen:AENDERN', { verbaende: ['LV1'], vorfahren }, true],
    ['K1', 'fristen:AENDERN', 'fristen:AENDERN', { verbaende: ['LV1'], vorfahren }, false],
    // mehrere Mitgliedschaften: eine im Bereich genügt
    ['LV1', 'mitglieder:LESEN', 'mitglieder:LESEN', { vereine: ['V2', 'V1'], heimatverein_id: 'V2', vorfahren }, true],
    // global nur aus dem Dachverband
    ['DJB', 'verbandsbaum:AENDERN', 'verbandsbaum:AENDERN', { global: true }, true],
    ['LV1', 'verbandsbaum:AENDERN', 'verbandsbaum:AENDERN', { global: true }, false],
    // nur der LV des Heimatvereins
    ['LV1', 'mitglieder:LOESCHEN', 'mitglieder:LOESCHEN', auf('V1'), true],
    ['V1', 'mitglieder:LOESCHEN', 'mitglieder:LOESCHEN', auf('V1'), false],
    ['K1', 'mitglieder:LOESCHEN', 'mitglieder:LOESCHEN', auf('V1'), false],
    ['DJB', 'mitglieder:LOESCHEN', 'mitglieder:LOESCHEN', auf('V1'), false],
    ['LV1', 'mitglieder:LOESCHEN', 'mitglieder:LOESCHEN', { vereine: ['V1', 'V2'], heimatverein_id: 'V2', vorfahren }, false],
    ['LV1', 'personen_zusammenfuehrung:AENDERN', 'personen_zusammenfuehrung:AENDERN', auf('V1'), true],
    ['DJB', 'personen_zusammenfuehrung:AENDERN', 'personen_zusammenfuehrung:AENDERN', auf('V1'), false],
    ['V1', 'mitglieder:AENDERN', 'mitglieder:AENDERN', auf('V1'), true],
    ['V1', 'mitglieder:AENDERN', 'mitglieder:AENDERN', auf('V1', { judopassdaten: true }), false],
    ['LV1', 'mitglieder:AENDERN', 'mitglieder:AENDERN', auf('V1', { judopassdaten: true }), true],
    // Judopass-Anträge: Heimatverein muss im Bereich liegen
    ['V1', 'judopass_antrag:LESEN', 'judopass_antrag:LESEN', auf('V1'), true],
    ['V1', 'judopass_antrag:LESEN', 'judopass_antrag:LESEN', { vereine: ['V1'], heimatverein_id: 'V2', vorfahren }, false],
  ])('Quelle %s mit %s: %s → %o = %s', (bereich, hat, recht, ziel, erwartet) => {
    expect(darf(mit(quelle(B[bereich], [hat])), recht, ziel)).toBe(erwartet);
  });

  it('kombiniert Quellen nie: Recht aus der einen und Bereich aus der anderen reichen nicht', () => {
    expect(darf(mit(quelle(B.LV1, ['mitglieder:LESEN']), quelle(B.V1, ['mitglieder:AENDERN'])), 'mitglieder:AENDERN', auf('V1'))).toBe(true);
    expect(darf(mit(quelle(B.DJB, ['mitglieder:LESEN']), quelle(B.V1, ['mitglieder:AENDERN'])), 'mitglieder:AENDERN', auf('V2'))).toBe(false);
  });
  it('ohne Ziel, ohne Quelle oder als Systemlauf: nein; eigene Person: nur lesen', () => {
    expect(darf(mit(quelle(B.DJB, ['mitglieder:LESEN'])), 'mitglieder:LESEN')).toBe(false);
    expect(darf(mit(), 'mitglieder:LESEN', auf('V1'))).toBe(false);
    expect(darf(systemCtx('x'), 'mitglieder:LESEN', auf('V1'))).toBe(false);
    expect(darf(mit(), 'mitglieder:LESEN', { eigen: true })).toBe(true);
    expect(darf(mit(), 'mitglieder:AENDERN', { eigen: true })).toBe(false);
  });
});

describe('Kontext', () => {
  const lizenz = quelle(B.K1, ['pruefung:LESEN'], 'lizenz');
  it('eine Lizenz wirkt im Verbandskontext ihres Bereichs und in jedem Verein darin, dort nur für diesen Verein', () => {
    expect(imKontext(lizenz, { art: 'verband', id: 'K1' })).toBe(lizenz);
    expect(imKontext(lizenz, { art: 'verband', id: 'LV1' })).toBeNull();
    expect(imKontext(lizenz, { art: 'verein', id: 'V1' }, vorfahren.V1).bereich).toEqual({ art: 'verein', id: 'V1' });
    expect(imKontext(lizenz, { art: 'verein', id: 'V2' }, vorfahren.V2)).toBeNull();
  });
  it('Verbandsrollen wirken nicht im Verein, Vereinsrollen nicht im Verband', () => {
    expect(imKontext(quelle(B.LV1, []), { art: 'verein', id: 'V1' }, vorfahren.V1)).toBeNull();
    expect(imKontext(quelle(B.V1, []), { art: 'verband', id: 'LV1' })).toBeNull();
    expect(imKontext(lizenz, null)).toBeNull();
  });
});

describe('projiziere()', () => {
  const person = { id: 'p', vorname: 'A', geburtsdatum: null, email: 'a@example.org', telefon: '1', passwort_hash: 'geheim' };
  it('Verbandsrollen sehen keine Kontaktdaten: Felder fehlen, leere bleiben', () => {
    expect(projiziere(mit(quelle(B.LV1, ['mitglieder:LESEN'])), 'person', person, auf('V1'))).toEqual({ id: 'p', vorname: 'A', geburtsdatum: null });
  });
  it('der Verein und die eigene Person sehen sie, unbekannte Felder nie', () => {
    const voll = { id: 'p', vorname: 'A', geburtsdatum: null, email: 'a@example.org', telefon: '1' };
    expect(projiziere(mit(quelle(B.V1, ['mitglieder:LESEN'])), 'person', person, auf('V1'))).toEqual(voll);
    expect(projiziere(mit(), 'person', person, { eigen: true })).toEqual(voll);
  });
  it('eine Quelle ohne Bereich über der Person erweitert die Felder nicht; ohne Zugriff null', () => {
    const ctx = mit(quelle(B.LV1, ['mitglieder:LESEN']), quelle({ art: 'verein', id: 'V2' }, ['mitglieder:LESEN']));
    expect(projiziere(ctx, 'person', person, auf('V1'))).not.toHaveProperty('email');
    expect(projiziere(mit(), 'person', person, auf('V1'))).toBeNull();
  });
});

it('Listenbereich und Einzelprüfung stimmen für alle Bereiche überein', () => {
  for (const b of Object.values(B)) {
    for (const recht of ['mitglieder:LESEN', 'mitglieder:LOESCHEN', 'judopass_antrag:LESEN']) {
      const ctx = mit(quelle(b, [recht]));
      const l = listenbereich(ctx, recht);
      for (const v of ['V1', 'V2']) expect(l.vereine.includes(v) || l.verbaende.some((x) => vorfahren[v].includes(x)), `${b.id} ${recht} ${v}`).toBe(darf(ctx, recht, auf(v)));
    }
  }
});

describe('über die API', () => {
  let t; let a; let b;
  const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
  beforeAll(async () => {
    t = await neueApp();
    a = await verbandsbaum(t.pool); b = await verbandsbaum(t.pool);
    await verein(t.pool, a.kreis);
    // Vergabe folgt mit 2.6; hier direkt, damit eine Rolle mit vereine:LESEN im Verband wirkt
    await q('alter table benutzer_verbandsrollen drop constraint benutzer_verbandsrollen_rolle_check');
    await gibRolle(t.pool, 'trainer1', 'landesvertreter', a.lv);
  });
  afterAll(() => t.schliessen());

  it('Liste = Einzelprüfung, außerhalb immer 404', async () => {
    const tokens = { lv: await verbandsToken(t, 'trainer1', a.lv) };
    for (const n of ['admin1', 'trainer1', 'schueler1']) tokens[n] = (await t.login(n)).body.access_token;
    await q(`update benutzer set ist_super_admin = true where benutzername = 'eltern1'`);
    tokens.super = (await t.login('eltern1')).body.access_token;
    const alle = (await q('select id from vereine where geloescht_am is null')).map((r) => r.id);
    const anzahl = {};
    for (const [name, tok] of Object.entries(tokens)) {
      const liste = (await t.api('GET', '/v2/vereine', null, tok)).body.vereine.map((v) => v.id);
      const einzeln = [];
      for (const id of [...alle, randomUUID()]) {
        const r = await t.api('GET', `/v2/vereine/${id}`, null, tok);
        expect([200, 404]).toContain(r.status);
        if (r.status === 200) einzeln.push(id);
      }
      expect(liste.sort(), name).toEqual(einzeln.sort());
      anzahl[name] = liste.length;
    }
    expect(anzahl).toEqual({ lv: 2, admin1: 1, trainer1: 0, schueler1: 0, super: alle.length });
    expect((await t.api('GET', `/v2/vereine/${b.verein}`, null, tokens.lv)).body).toMatchObject({ status: 404, code: 'nicht_gefunden' });
  });
});
