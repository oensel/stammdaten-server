// Regressionen aus dem Review der Stories 1.2–2.4 (Befunde 9–21)
import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { createPool } from '../src/db.js';
import { verlangeAktuellesSchema } from '../src/migrate.js';
import { versendeMails } from '../src/module/benachrichtigung/dienst.js';
import { ladeQuellen } from '../src/module/rechte/dienst.js';
import { systemCtx } from '../src/pipeline/ctx.js';
import { gibRolle, verbandsbaum, verbandsToken } from './fabrik.js';
import { CLIENT, neueApp, PW } from './helper.js';

let t; let baum; let jc; let mails;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const claims = (j) => JSON.parse(Buffer.from(j.split('.')[1], 'base64url').toString());
const uid = async (n) => (await q('select id from benutzer where benutzername = $1', [n]))[0].id;
const tok = async (n, x) => (await t.login(n, x)).body.access_token;
const audits = () => q('select aktion, objekt_art, akteur, rolle, ebene_id, anwendung, alt, neu, grund from audit_log order by id');
const entscheide = async (id, entscheidung) => {
  const [z] = await q('select change_seq from benutzer_vereine where id = $1', [id]);
  return t.app.inject({
    method: 'PATCH', url: `/v2/vereine/${jc}/zugehoerigkeiten/${id}`, payload: { entscheidung },
    headers: { authorization: `Bearer ${await tok('admin1')}`, 'if-match': `"${z.change_seq}"` },
  });
};
beforeEach(async () => {
  mails = [];
  t = await neueApp({ mailer: { send: async (m) => { mails.push(m); return { ok: true }; } }, backchannelWartenMs: [0] });
  baum = await verbandsbaum(t.pool);
  jc = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
});
afterEach(() => t.schliessen());

describe('App-Obergrenze (9)', () => {
  const ohne = (scope) => q('update anwendungen set client_scopes = \'{}\', scopes = array_remove(scopes, $2) where schluessel = $1', [CLIENT, scope]);
  it('Vereinsliste und Verbandsbaum brauchen den Scope der App', async () => {
    await gibRolle(t.pool, 'trainer1', 'djb_admin', baum.djb);
    const djb = await verbandsToken(t, 'trainer1', baum.djb);
    const neu = (name) => t.api('POST', '/v2/verbaende', { name, typ: 'landesverband', uebergeordnet_id: baum.djb }, djb);
    expect((await neu('LV A')).status).toBe(201);
    await ohne('verband:verwalten');
    expect((await neu('LV B')).status).toBe(404);
    const admin = await tok('admin1');
    expect((await t.api('GET', '/v2/vereine', null, admin)).body.vereine).toHaveLength(1);
    await ohne('vereine:lesen');
    expect((await t.api('GET', '/v2/vereine', null, admin)).body.vereine).toEqual([]);
    expect((await t.api('GET', `/v2/vereine/${jc}`, null, admin)).status).toBe(404);
  });
});

it('10: der Verbandskontext endet unter /v2 sofort mit dem letzten Verein', async () => {
  await gibRolle(t.pool, 'trainer1', 'lv_admin', baum.lv);
  const k = await verbandsToken(t, 'trainer1', baum.lv);
  const setze = () => t.api('PUT', `/v2/verbaende/${baum.lv}/fristen/vorabankuendigung`, { wert: 5 }, k);
  expect((await setze()).status).toBe(200);
  await q(`update benutzer_vereine set status = 'gesperrt' where benutzer_id = $1`, [await uid('trainer1')]);
  expect((await setze()).status).toBe(404);
});

it('11: Entzug beendet Kinder- und Mitgliedsbezug, Freigabe belebt sie nicht', async () => {
  for (const n of ['eltern1', 'schueler1']) {
    const [z] = await q('select id from benutzer_vereine where benutzer_id = $1', [await uid(n)]);
    expect((await t.login(n)).body.benutzer.vereine[0].mitglied_ids.length).toBeGreaterThan(0);
    for (const e of ['entziehen', 'freigeben']) expect((await entscheide(z.id, e)).statusCode).toBe(200);
    expect((await t.login(n)).body.benutzer.vereine[0]).toMatchObject({ mitglied_id: null, mitglied_ids: [] });
  }
});

describe('Audit (12, 20)', () => {
  it('Verbandsaktionen tragen die Verbandsrolle', async () => {
    await gibRolle(t.pool, 'trainer1', 'djb_admin', baum.djb);
    await t.api('POST', '/v2/verbaende', { name: 'LV X', typ: 'landesverband', uebergeordnet_id: baum.djb }, await verbandsToken(t, 'trainer1', baum.djb));
    expect(await audits()).toMatchObject([{ aktion: 'verband_angelegt', rolle: 'djb_admin', ebene_id: baum.djb }]);
  });
  it('Rechte geben und entziehen; ein wirkungsloser Entzug schreibt nichts', async () => {
    const admin = await tok('admin1'); const url = `/benutzer/${await uid('schueler1')}/rechte/trainer`;
    await t.api('PUT', url, {}, admin);
    await t.api('DELETE', url, null, admin);
    await t.api('DELETE', url, null, admin);
    expect(await audits()).toMatchObject([
      { aktion: 'recht_vergeben', akteur: await uid('admin1'), rolle: 'admin', ebene_id: jc, neu: { recht: 'trainer' } },
      { aktion: 'recht_entzogen', alt: { recht: 'trainer' } },
    ]);
  });
  it('Zugang anlegen, Einladung annehmen, Konto löschen', async () => {
    const admin = await tok('admin1');
    await t.api('POST', '/benutzer', { benutzername: 'kind' }, admin);
    await t.api('POST', '/einladungen', { email: 'x@example.org', rolle: 'admin' }, admin);
    await t.api('POST', '/auth/einladung-annehmen', { token: mails[0].text.match(/token=(\S+)/)[1], benutzername: 'xneu', passwort_neu: PW });
    await t.api('DELETE', '/ich', { passwort: PW }, await tok('xneu'));
    expect(await audits()).toMatchObject([
      { aktion: 'recht_vergeben', objekt_art: 'vereinszugehoerigkeit', akteur: await uid('admin1') },
      { aktion: 'recht_vergeben', akteur: await uid('xneu'), anwendung: 'system:einladung', neu: { rolle: 'admin' }, grund: expect.stringContaining(await uid('admin1')) },
      { aktion: 'recht_entzogen', objekt_art: 'benutzer', akteur: await uid('xneu') },
    ]);
  });
});

it('14: der Kontextwechsel behält die sid; Abmelden meldet sie an die Apps', async () => {
  const logout = [];
  const srv = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { logout.push(JSON.parse(d).logout_token); res.end(); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await q('update anwendungen set backchannel_url = $1 where schluessel = $2', [`http://127.0.0.1:${srv.address().port}/`, CLIENT]);
    await gibRolle(t.pool, 'trainer1', 'lv_admin', baum.lv);
    const l = (await t.login('trainer1')).body;
    const k = (await t.api('POST', '/v2/auth/kontext-wechseln', { art: 'verband', id: baum.lv }, l.access_token)).body;
    const v = (await t.api('POST', '/auth/verein-wechseln', { verein_id: jc }, k.access_token)).body;
    expect([claims(k.access_token).sid, claims(v.access_token).sid]).toEqual([claims(l.access_token).sid, claims(l.access_token).sid]);
    for (const alt of [l, k]) expect((await t.refresh(alt.refresh_token)).status).toBe(401); // alte Refresh-Tokens sind tot
    await t.api('POST', '/auth/logout', { refresh_token: v.refresh_token });
    await t.app.backchannelFertig();
    expect(logout.map((x) => claims(x).sid)).toEqual([claims(l.access_token).sid]);
  } finally { await new Promise((r) => srv.close(r)); }
});

it('17: Abmelden oder Wechseln parallel zur Erneuerung hinterlässt keine offene Sitzung', async () => {
  for (let i = 0; i < 8; i++) {
    const l = (await t.login('admin1')).body;
    await Promise.all([t.refresh(l.refresh_token), t.api('POST', '/auth/logout', i % 2 ? { refresh_token: l.refresh_token } : { alle_geraete: true }, l.access_token)]);
    expect(await q('select 1 from refresh_tokens where familie_id = $1 and widerrufen_am is null', [claims(l.access_token).sid])).toEqual([]);
  }
  const l = (await t.login('admin1')).body;
  const [, w] = await Promise.all([t.refresh(l.refresh_token), t.api('POST', '/auth/verein-wechseln', { verein_id: jc }, l.access_token)]);
  expect(w.status).toBe(200);
});

describe('QR ohne freigegebenen Verein (19)', () => {
  const frage = (token, benutzername, passwort) => t.api('POST', '/v2/auth/zugehoerigkeit-anfragen', { token, benutzername, passwort });
  it('mit Passwort anfragen, ohne Sitzung; falsche Passwörter sperren das Konto', async () => {
    const id = await uid('schueler1');
    await q(`update benutzer_vereine set status = 'abgelehnt' where benutzer_id = $1`, [id]);
    expect((await t.login('schueler1')).body.code).toBe('kein_verein');
    const { token } = (await t.api('POST', `/v2/vereine/${jc}/qr-codes`, {}, await tok('admin1'))).body;
    expect((await frage('x'.repeat(40), 'schueler1', PW)).status).toBe(404);
    expect((await frage(token, 'gibtesnicht', PW)).body).toMatchObject({ status: 401, code: 'anmeldung_fehlgeschlagen' });
    const r = await frage(token, 'schueler1', PW);
    expect(r).toMatchObject({ status: 201, body: { verein_id: jc, status: 'angefragt' } });
    expect(r.body).not.toHaveProperty('access_token');
    expect((await q('select status, mitglied_id from benutzer_vereine where benutzer_id = $1', [id]))[0]).toEqual({ status: 'angefragt', mitglied_id: null });
    for (let i = 0; i < 5; i++) expect((await frage(token, 'trainer1', 'falsch')).status).toBe(401);
    expect((await frage(token, 'trainer1', PW)).status).toBe(429);
    expect((await t.login('trainer1')).status).toBe(429); // dieselbe Sperre wie beim Login
  });
  it('wer im Verein gesperrt ist, kommt so nicht zurück', async () => {
    await q(`update benutzer_vereine set status = 'gesperrt' where benutzer_id = $1`, [await uid('schueler1')]);
    const { token } = (await t.api('POST', `/v2/vereine/${jc}/qr-codes`, {}, await tok('admin1'))).body;
    expect((await frage(token, 'schueler1', PW)).body.code).toBe('zugehoerigkeit_vorhanden');
  });
});

describe('Betrieb (13, 15, 16, 18)', () => {
  it('15: während des Versands ist keine Transaktion offen; ein Absturz wird nach der Reservierung wiederholt', async () => {
    const jetzt = new Date('2030-01-01T10:00:00Z');
    await q('insert into mail_auftraege (an, betreff, text, erstellt_am, naechster_versuch_am) values ($1,$1,$1,$2,$2)', ['a@example.org', jetzt]);
    const lauf = (min, send) => versendeMails(systemCtx('x', { jetzt: new Date(jetzt.getTime() + min * 60_000) }), t.pool, { mailer: { send } });
    let offen;
    await expect(lauf(0, async () => {
      offen = await q(`select 1 from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`);
      throw new Error('Absturz');
    })).rejects.toThrow('Absturz');
    expect(offen).toEqual([]);
    expect(await lauf(1, async () => ({ ok: true }))).toEqual({ gesendet: 0 });
    expect(await lauf(16, async () => ({ ok: true }))).toEqual({ gesendet: 1 });
  });
  it('16: verlorene Verbindungen, ruhend und ausgecheckt, werfen keinen unbehandelten Fehler', async () => {
    const pool = createPool(t.pool.options.connectionString);
    const c = await pool.connect();
    const ruhend = await pool.connect();
    const pids = [];
    for (const x of [c, ruhend]) pids.push((await x.query('select pg_backend_pid() p')).rows[0].p);
    ruhend.release();
    await q('select pg_terminate_backend(p) from unnest($1::int[]) p', [pids]);
    await new Promise((r) => setTimeout(r, 300)); // ohne Listener bräche der Testlauf hier ab
    c.release(new Error('weg'));
    expect((await pool.query('select 1 eins')).rows).toEqual([{ eins: 1 }]);
    await pool.end();
  });
  it('18: ohne alle Migrationen startet nichts', async () => {
    await expect(verlangeAktuellesSchema(t.pool)).resolves.toBeUndefined();
    await q(`delete from schema_migrationen where name = '016_abgleich_epoche.sql'`);
    await expect(verlangeAktuellesSchema(t.pool)).rejects.toThrow('016_abgleich_epoche.sql');
  });
});

describe('Migration auf Bestandsdaten (13, 21)', () => {
  async function aufStand9(fn) {
    const base = inject('pgBase'); const name = `m_${Date.now()}`;
    const admin = new pg.Client({ connectionString: `${base}/postgres` });
    await admin.connect();
    await admin.query(`create database ${name}`);
    const c = new pg.Client({ connectionString: `${base}/${name}` });
    await c.connect();
    const db = path.resolve(import.meta.dirname, '..', 'db');
    const dateien = (await readdir(path.join(db, 'migrations'))).sort();
    const spiele = async (liste) => { for (const f of liste) await c.query(await readFile(path.join(db, 'migrations', f), 'utf8')); };
    try {
      await c.query(await readFile(path.join(db, 'schema.sql'), 'utf8'));
      await spiele(dateien.filter((f) => f < '010'));
      await fn(c, () => spiele(dateien.filter((f) => f >= '010')));
    } finally {
      await c.end();
      await admin.query(`drop database ${name}`);
      await admin.end();
    }
  }
  const lege = async (c, typ, eltern) => (await c.query('insert into verbaende (name, typ, uebergeordnet_id) values ($1,$1,$2) returning id', [typ, eltern])).rows[0].id;

  it('baut verband_pfade für vorhandene Verbände und Vereine auf', async () => {
    await aufStand9(async (c, weiter) => {
      let id = null; const kette = [];
      for (const typ of ['dachverband', 'landesverband', 'bezirk', 'kreis']) { id = await lege(c, typ, id); kette.unshift(id); }
      const v = (await c.query(`insert into vereine (name, verband_id) values ('V', $1) returning id`, [id])).rows[0].id;
      await weiter();
      expect((await c.query('select vorfahr_id from verband_pfade where nachfahr_id = $1 order by tiefe', [v])).rows.map((r) => r.vorfahr_id)).toEqual(kette);
    });
  });
  it('bricht bei verletzter Ebenenfolge mit den Namen ab', async () => {
    await aufStand9(async (c, weiter) => {
      const lv = await lege(c, 'landesverband', null);
      await c.query(`insert into vereine (name, verband_id) values ('Falsch', $1)`, [lv]);
      await expect(weiter()).rejects.toThrow(/Verband landesverband.*Verein Falsch|Verein Falsch.*Verband landesverband/);
    });
  });
});

describe('Testlücken (21)', () => {
  it('Geräte-Tokens tragen unter /v2 weder Super-Admin- noch Verbandsrechte und bleiben am Verein', async () => {
    await q(`update benutzer set ist_super_admin = true where benutzername = 'admin1'`);
    await gibRolle(t.pool, 'admin1', 'djb_admin', baum.djb);
    await q(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'admin','freigegeben')`, [await uid('admin1'), baum.verein]);
    const g = await tok('admin1', { verein_id: jc, geraet: { typ: 'tablet', name: 'T' }, geraet_token: true });
    expect((await t.api('GET', '/v2/ich', null, g)).body).toMatchObject({ super_admin: false, rollen: ['admin'] });
    expect((await t.api('POST', '/v2/verbaende', { name: 'X', typ: 'landesverband', uebergeordnet_id: baum.djb }, g)).status).toBe(404);
    const x = (v) => t.app.inject({ method: 'GET', url: '/v2/ich', headers: { authorization: `Bearer ${g}`, 'x-verein': v } });
    expect([(await x(jc)).statusCode, (await x(baum.verein)).statusCode]).toEqual([200, 404]);
  });

  it('Quellen: Ebene je Verband, Kontaktfelder nur für Vereinsrollen außer Trainer', async () => {
    const verbandsquellen = async (rolle, id) => (await ladeQuellen(null, t.pool, { kontext: { art: 'verband', id }, verbandsrollen: [{ rolle, verband_id: id }] }))[0];
    expect((await verbandsquellen('djb_admin', baum.djb)).bereich.ebene).toBe('dachverband');
    expect((await verbandsquellen('landesvertreter', baum.lv)).bereich.ebene).toBe('landesverband');
    expect((await verbandsquellen('bezirks_dan_beauftragter', baum.bezirk)).bereich.ebene).toBe('bezirk');
    expect((await verbandsquellen('kreis_dan_vorsitzender', baum.kreis)).bereich.ebene).toBe('kreis');
    expect((await verbandsquellen('landesvertreter', baum.lv)).felder).toEqual(['stamm']);
    const verein = await ladeQuellen(null, t.pool, { kontext: { art: 'verein', id: jc }, rolle: 'admin', rechte: ['trainer', 'kassierer', 'pruefer'] });
    expect(Object.fromEntries(verein.map((x) => [x.schluessel, x.felder]))).toEqual({ admin: null, kassierer: null, trainer: ['stamm'] });
  });

  it('Seed-Matrix: Rollen haben genau die vorgesehenen Rechte', async () => {
    const soll = {
      trainer: 'graduierung:LESEN lehrgang_teilnahme:LESEN mannschaft:AENDERN mannschaft:ANLEGEN mannschaft:LESEN mannschaft:LOESCHEN mitglieder:LESEN pruefung:AENDERN pruefung:ANLEGEN pruefung:LESEN pruefung:LOESCHEN turnier_meldung:AENDERN turnier_meldung:ANLEGEN turnier_meldung:LESEN',
      kassierer: 'beitraege:AENDERN beitraege:LESEN ueberweisung:AENDERN ueberweisung:ANLEGEN ueberweisung:LESEN',
      mitglied: '', super_admin: '',
      lehrgangsfreigabe: 'lehrgang:LESEN lehrgang_freigabe:AENDERN',
      dan_pruefungsorganisation: 'pruefung:AENDERN pruefung:ANLEGEN pruefung:LESEN pruefung:LOESCHEN',
      verbandskassierer: 'forderungen:AENDERN forderungen:LESEN mandate:LESEN rechnungslauf:AENDERN rechnungslauf:ANLEGEN rechnungslauf:LESEN',
      lv_admin: 'fristen:AENDERN fristen:LESEN gebuehren:AENDERN gebuehren:LESEN lehrgangstyp:AENDERN lehrgangstyp:ANLEGEN lehrgangstyp:LESEN lehrgangstyp:LOESCHEN lizenz:AENDERN lizenz:ANLEGEN lizenz_aussetzung:AENDERN lizenz_aussetzung:ANLEGEN verbandsrolle:ANLEGEN verbandsrolle:LESEN verbandsrolle:LOESCHEN',
    };
    soll.djb_admin = `${soll.lv_admin} verbandsbaum:AENDERN verbandsbaum:LESEN`.split(' ').sort().join(' ');
    const ist = Object.fromEntries((await q(`select r.schluessel, coalesce(string_agg(b.recht || ':' || b.operation, ' '), '') as x
      from rollen r left join rollen_berechtigungen b on b.rolle_id = r.id where r.verein_id is null group by 1`)).map((r) => [r.schluessel, r.x.split(' ').sort().join(' ')]));
    expect(Object.fromEntries(Object.keys(soll).map((k) => [k, ist[k]]))).toEqual(soll);
    // Nur diese Rollen dürfen Personen löschen, zusammenführen oder suchen
    const mit = (r) => Object.keys(ist).filter((k) => ist[k].split(' ').includes(r)).sort();
    expect([mit('mitglieder:LOESCHEN'), mit('personen_zusammenfuehrung:AENDERN'), mit('personen:SUCHEN')]).toEqual([['admin', 'landesvertreter'], ['landesvertreter'], ['landesvertreter']]);
  });
});
