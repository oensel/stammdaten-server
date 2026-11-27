// Story 3.9 (FR-9, FR-10, E27, E31, E73, E82): Transfer
import { afterEach, beforeEach, expect, it } from 'vitest';
import { gibRolle, verbandsbaum, verbandsToken, verein as neuerVerein } from './fabrik.js';
import { CLIENT, neueApp } from './helper.js';
import { fuehreAus } from '../src/worker.js';

let t; let uhr; let baum; let jc; let b; let thomas; let thomasP; let lena; let lenaP; let id;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const tok = async (n, v) => (await t.login(n, v ? { verein_id: v } : {})).body.access_token;
beforeEach(async () => {
  uhr = new Date('2030-06-15T10:00:00Z');
  t = await neueApp({ uhr: () => uhr });
  baum = await verbandsbaum(t.pool);
  await q(`update anwendungen set scopes = scopes || '{mitglieder:schreiben}' where schluessel = $1 and not scopes @> '{mitglieder:schreiben}'`, [CLIENT]);
  jc = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  b = await neuerVerein(t.pool, baum.kreis);
  await q('update vereine set verband_id = $2 where id = $1', [jc, baum.kreis]);
  id = Object.fromEntries((await q('select benutzername, id from benutzer')).map((x) => [x.benutzername, x.id]));
  await q(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1, $2, 'admin', 'freigegeben')`, [id.pruefer1, b]);
  [{ id: thomas, person_id: thomasP }] = await q(`select id, person_id from mitglieder where vorname = 'Thomas'`);
  [{ id: lena, person_id: lenaP }] = await q(`select id, person_id from mitglieder where vorname = 'Lena'`);
  await q(`insert into mitglieder (person_id, verein_id, mitgliedsnr, vorname, nachname) values ($1,$2,1,'x','x')`, [lenaP, b]);
  await q('update mitglieder set eintritt = null, austritt = null where id = any($1)', [[thomas, lena]]);
});
afterEach(() => t.schliessen());

const ruf = async (method, url, payload, token, version) => {
  const r = await t.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token ?? await tok('admin1')}`, ...(version ? { 'if-match': `"${version}"` } : {}) } });
  return { status: r.statusCode, body: r.json() };
};
const senden = (person_id, extra = {}, token, von = jc) => ruf('POST', `/v2/vereine/${von}/transfers`, { person_id, nach_verein_id: b, wirksam_ab: '2030-07-01', ...extra }, token);
const adminB = () => tok('pruefer1', b);
const entscheide = (tr, body, token) => ruf('PATCH', `/v2/vereine/${tr.nach_verein_id}/transfers/${tr.id}`, body, token, tr.change_seq);
const lauf = (d) => fuehreAus(t.pool, 'transfers', {}, { jetzt: new Date(d) });
const person = async (p) => (await q('select heimatverein_id from personen where id = $1', [p]))[0].heimatverein_id;
const ms = async (p, v) => (await q('select id, status, austritt, mitgliedsnr from mitglieder where person_id = $1 and verein_id = $2', [p, v]))[0];
const rechte = async () => (await q('select count(*)::int n from benutzer_rechte where benutzer_id = $1 and geloescht_am is null', [id.trainer1]))[0].n;

it('Vereinswechsel: senden, annehmen, am Wirksamkeitstag vollzogen; alte Mitgliedschaft endet, Heimatverein wechselt', async () => {
  const s = await senden(thomasP);
  expect(s).toMatchObject({ status: 201, body: { art: 'vereinswechsel', status: 'gesendet', nach_mitgliedschaft: null, gesendet_im_kontext: 'abgebender_verein' } });
  expect((await q(`select 1 from nachrichten where art = 'transfer_eingegangen'`)).length).toBeGreaterThan(0);
  const ein = (await ruf('GET', `/v2/vereine/${b}/transfers?richtung=eingehend`, null, await adminB())).body.transfers;
  expect(ein).toHaveLength(1);
  expect(ein[0]).toMatchObject({ vorname: 'Thomas', grad: null });
  expect(ein[0].geburtsdatum).toBeDefined();
  expect(ein[0]).not.toHaveProperty('person_id'); // der aufnehmende Verein kennt die Person erst nach dem Vollzug
  expect(ein[0]).not.toHaveProperty('von_verein_id');
  expect(await rechte()).toBeGreaterThan(0);
  const a = await entscheide(ein[0], { entscheidung: 'annehmen' }, await adminB());
  expect(a.body.status).toBe('angenommen');
  expect(await person(thomasP)).toBe(jc);
  expect(await lauf('2030-06-30T12:00:00Z')).toEqual({ vollzogen: 0, abgebrochen: 0 });
  expect(await lauf('2030-07-01T12:00:00Z')).toEqual({ vollzogen: 1, abgebrochen: 0 });
  expect(await person(thomasP)).toBe(b);
  expect(await ms(thomasP, jc)).toMatchObject({ status: 'ausgetreten', austritt: expect.anything() });
  expect(await ms(thomasP, b)).toMatchObject({ status: 'aktiv', mitgliedsnr: 2 }); // Lena hat in B schon die 1
  expect(await rechte()).toBe(0); // Vereinsrollen im alten Verein enden
  expect(await q(`select 1 from audit_log where aktion = 'recht_entzogen' and grund = 'Austritt'`)).toHaveLength(1);
  expect((await ruf('GET', `/v2/vereine/${jc}/transfers?richtung=ausgehend`)).body.transfers[0]).toMatchObject({ status: 'vollzogen', person_id: thomasP });
  expect(await lauf('2030-07-02T12:00:00Z')).toEqual({ vollzogen: 0, abgebrochen: 0 });
});

it('Heimatwechsel: der Server schlägt ihn vor, beide Mitgliedschaften bleiben, bei erreichtem Tag sofort vollzogen', async () => {
  const s = await senden(lenaP, { wirksam_ab: '2030-06-01' });
  expect(s.body).toMatchObject({ art: 'heimatwechsel' });
  expect(s.body.nach_mitgliedschaft).not.toBeNull();
  const a = await entscheide((await ruf('GET', `/v2/vereine/${b}/transfers?richtung=eingehend`, null, await adminB())).body.transfers[0], { entscheidung: 'annehmen' }, await adminB());
  expect(a.body).toMatchObject({ status: 'vollzogen', person_id: lenaP });
  expect(await person(lenaP)).toBe(b);
  expect((await ms(lenaP, jc)).status).toBe('aktiv');
  expect((await ms(lenaP, b)).status).toBe('aktiv');
  expect(await q('select 1 from mitglieder where person_id = $1', [lenaP])).toHaveLength(2); // keine zweite Mitgliedschaft in B
});

it('je Person ein offener Transfer; Art, Ziel und Absender werden geprüft', async () => {
  expect((await senden(thomasP, { art: 'heimatwechsel' })).body.code).toBe('art_unzulaessig');
  expect((await senden(thomasP, { nach_verein_id: jc })).body.code).toBe('zielverein_ungueltig');
  const fern = (await q(`insert into vereine (name, land, verband_id) values ('Fern', 'AT', $1) returning id`, [baum.kreis]))[0].id;
  expect((await senden(thomasP, { nach_verein_id: fern })).body.code).toBe('zielverein_ungueltig');
  const weg = (await q(`insert into vereine (name, aufgeloest_am, verband_id) values ('Weg', '2020-01-01', $1) returning id`, [baum.kreis]))[0].id;
  expect((await senden(thomasP, { nach_verein_id: weg })).body.code).toBe('verein_aufgeloest');
  expect((await senden(thomasP)).status).toBe(201);
  expect((await senden(thomasP)).body.code).toBe('transfer_offen');
  // Der Pass liegt bei jc: B darf die Person nicht senden und erfährt nichts von ihr
  expect((await senden(thomasP, { nach_verein_id: jc }, await adminB(), b)).status).toBe(404);
});

it('Rechte: nur Admin des abgebenden Vereins sendet; der Landesverband aus seinem Teilbaum; eingehende nur B', async () => {
  for (const wer of ['trainer1', 'schueler1', 'eltern1']) expect((await senden(thomasP, {}, await tok(wer))).status).toBe(404);
  await gibRolle(t.pool, 'trainer1', 'landesvertreter', baum.lv);
  const lv = await verbandsToken(t, 'trainer1', baum.lv);
  const s = await senden(thomasP, {}, lv);
  expect(s).toMatchObject({ status: 201, body: { gesendet_im_kontext: 'landesverband' } });
  expect((await ruf('GET', `/v2/vereine/${jc}/transfers?richtung=ausgehend`, null, lv)).body.transfers).toHaveLength(1);
  expect((await ruf('GET', `/v2/vereine/${jc}/transfers?richtung=eingehend`)).body.transfers).toEqual([]); // A sieht nur, was bei ihm eingeht
  expect((await ruf('GET', `/v2/vereine/${b}/transfers?richtung=eingehend`, null, lv)).status).toBe(404); // der Landesverband nimmt nicht an
  expect((await ruf('GET', `/v2/vereine/${b}/transfers?richtung=eingehend`, null, await tok('trainer1'))).status).toBe(404);
});

it('ablehnen und zurückziehen, auch nach der Annahme; danach ist ein neuer Transfer möglich', async () => {
  const s = (await senden(thomasP)).body;
  const ein = (await ruf('GET', `/v2/vereine/${b}/transfers?richtung=eingehend`, null, await adminB())).body.transfers[0];
  expect((await entscheide({ ...ein, change_seq: 1 }, { entscheidung: 'annehmen' }, await adminB())).body.code).toBe('version_veraltet');
  expect((await entscheide(ein, { entscheidung: 'ablehnen', grund: 'kein Platz' }, await adminB())).body).toMatchObject({ status: 'abgelehnt' });
  expect((await entscheide({ ...ein, change_seq: (await q('select change_seq from transfers where id = $1', [ein.id]))[0].change_seq }, { entscheidung: 'ablehnen' }, await adminB())).status).toBe(409);
  expect((await ruf('GET', `/v2/vereine/${jc}/transfers?richtung=ausgehend`)).body.transfers[0]).toMatchObject({ status: 'abgelehnt', grund: 'kein Platz' });
  const s2 = (await senden(thomasP)).body;
  const ein2 = (await ruf('GET', `/v2/vereine/${b}/transfers?richtung=eingehend&status=gesendet`, null, await adminB())).body.transfers[0];
  await entscheide(ein2, { entscheidung: 'annehmen' }, await adminB());
  expect((await ruf('DELETE', `/v2/vereine/${b}/transfers/${s2.id}`, null, await adminB())).status).toBe(404); // nur der Absender
  expect((await ruf('DELETE', `/v2/vereine/${jc}/transfers/${s2.id}`)).body.status).toBe('zurueckgezogen');
  expect(await lauf('2030-07-02T12:00:00Z')).toEqual({ vollzogen: 0, abgebrochen: 0 });
  expect(await person(thomasP)).toBe(jc);
  expect((await ruf('DELETE', `/v2/vereine/${jc}/transfers/${s2.id}`)).status).toBe(409);
  expect(s.id).not.toBe(s2.id);
  expect((await senden(thomasP)).status).toBe(201);
});

it('der Vollzug prüft erneut: Pass woanders oder Zielverein aufgelöst → abgebrochen mit Grund', async () => {
  const c = (await q(`insert into vereine (name, verband_id) values ('Dritter', $1) returning id`, [baum.kreis]))[0].id;
  await q(`insert into mitglieder (person_id, verein_id, mitgliedsnr, vorname, nachname) values ($1,$2,1,'x','x')`, [thomasP, c]);
  const s = (await senden(thomasP)).body;
  const ein = (await ruf('GET', `/v2/vereine/${b}/transfers?richtung=eingehend`, null, await adminB())).body.transfers[0];
  await entscheide(ein, { entscheidung: 'annehmen' }, await adminB());
  await q('update personen set heimatverein_id = $2 where id = $1', [thomasP, c]);
  expect(await lauf('2030-07-01T12:00:00Z')).toEqual({ vollzogen: 0, abgebrochen: 1 });
  expect((await q('select status, grund from transfers where id = $1', [s.id]))[0]).toMatchObject({ status: 'abgebrochen', grund: expect.stringContaining('Pass') });
  expect(await person(thomasP)).toBe(c);
  // Zielverein aufgelöst
  await q('update personen set heimatverein_id = $2 where id = $1', [thomasP, jc]);
  const s2 = (await senden(thomasP)).body;
  await entscheide((await ruf('GET', `/v2/vereine/${b}/transfers?richtung=eingehend&status=gesendet`, null, await adminB())).body.transfers[0], { entscheidung: 'annehmen' }, await adminB());
  await q(`update vereine set aufgeloest_am = '2030-06-20' where id = $1`, [b]);
  expect(await lauf('2030-07-01T12:00:00Z')).toEqual({ vollzogen: 0, abgebrochen: 1 });
  expect((await q('select grund from transfers where id = $1', [s2.id]))[0].grund).toContain('aufgelöst');
});

it('ruhende und ausgetretene Mitglieder mit Pass sind transferierbar; in B wird eine ausgetretene Mitgliedschaft genutzt', async () => {
  await q(`update mitglieder set status = 'ausgetreten', austritt = '2025-01-01' where id = $1`, [thomas]);
  const bm = (await q(`insert into mitglieder (person_id, verein_id, mitgliedsnr, vorname, nachname, status) values ($1,$2,7,'x','x','ausgetreten') returning id`, [thomasP, b]))[0].id;
  const s = (await senden(thomasP, { art: 'vereinswechsel' })).body;
  expect(s.nach_mitgliedschaft).toBe(bm);
  await entscheide((await ruf('GET', `/v2/vereine/${b}/transfers?richtung=eingehend`, null, await adminB())).body.transfers[0], { entscheidung: 'annehmen' }, await adminB());
  await lauf('2030-07-01T12:00:00Z');
  expect(await ms(thomasP, b)).toMatchObject({ status: 'aktiv', mitgliedsnr: 7 });
  expect(await q('select 1 from mitglieder where person_id = $1', [thomasP])).toHaveLength(2);
  expect((await ms(thomasP, jc)).austritt.toISOString?.().slice(0, 10) ?? (await ms(thomasP, jc)).austritt).toMatch(/2025-01-01/); // least(austritt, wirksam_ab)
  expect(await person(thomasP)).toBe(b);
});
