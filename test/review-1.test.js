// Regressionen aus dem Review der Stories 1.2–2.4 (Befunde 1–8)
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as organisation from '../src/module/organisation/daten.js';
import { gibRolle, verbandsbaum, verbandsToken } from './fabrik.js';
import { CLIENT, cfgDefault, neueApp, PW } from './helper.js';

let t; let baum; let jc; let mails;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const claims = (j) => JSON.parse(Buffer.from(j.split('.')[1], 'base64url').toString());
const uid = async (n) => (await q('select id from benutzer where benutzername = $1', [n]))[0].id;
const tok = async (n, x) => (await t.login(n, x)).body.access_token;
const token = (m) => m.text.match(/token=(\S+)/)[1];
const annehmen = (body) => t.api('POST', '/auth/einladung-annehmen', body);
const einladen = async (email, rolle = 'admin') => {
  const n = mails.length;
  expect((await t.api('POST', '/einladungen', { email, rolle }, await tok('admin1'))).status).toBe(202);
  return token(mails[n]);
};
beforeEach(async () => {
  mails = [];
  t = await neueApp({ mailer: { send: async (m) => { mails.push(m); return { ok: true }; } } });
  baum = await verbandsbaum(t.pool);
  jc = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
});
afterEach(() => t.schliessen());

it('1: Konten mit Verbandsrolle lassen sich vom Verein nicht zurücksetzen, nach Ende der Rolle wieder', async () => {
  await gibRolle(t.pool, 'schueler1', 'djb_admin', baum.djb);
  const url = `/benutzer/${await uid('schueler1')}/passwort-zuruecksetzen`;
  for (const n of ['trainer1', 'admin1']) expect((await t.api('POST', url, null, await tok(n))).body).toMatchObject({ status: 403, code: 'konto_geschuetzt' });
  expect((await t.login('schueler1')).status).toBe(200);
  await q('update benutzer_verbandsrollen set beendet_am = now()');
  expect((await t.api('POST', url, null, await tok('trainer1'))).status).toBe(200);
});

it('2: Geräte-Anmeldungen bleiben an ihrem Verein; derselbe Verein und die normale Erneuerung gehen', async () => {
  await q(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'admin','freigegeben')`, [await uid('schueler1'), baum.verein]);
  let rt = (await t.login('schueler1', { verein_id: jc, geraet: { typ: 'tablet', name: 'T' }, geraet_token: true })).body.refresh_token;
  const erneuere = (verein) => t.api('POST', `/oauth/token?verein=${verein}`, { grant_type: 'refresh_token', refresh_token: rt });
  expect((await erneuere(baum.verein)).body).toMatchObject({ status: 400, code: 'geraet_gebunden' });
  const gleich = await erneuere(jc);
  expect(claims(gleich.body.access_token)).toMatchObject({ verein_id: jc, rolle: 'mitglied' });
  rt = gleich.body.refresh_token;
  expect((await t.refresh(rt)).status).toBe(200);
});

it('2: eine schon auf einen fremden Verein umgestellte Geräte-Sitzung endet', async () => {
  await q(`insert into benutzer_vereine (benutzer_id, verein_id, rolle, status) values ($1,$2,'admin','freigegeben')`, [await uid('schueler1'), baum.verein]);
  const { refresh_token: rt } = (await t.login('schueler1', { verein_id: jc, geraet: { typ: 'tablet', name: 'T' }, geraet_token: true })).body;
  await q('update refresh_tokens set verein_id = $1 where geraet_id is not null', [baum.verein]);
  expect((await t.refresh(rt)).status).toBe(401);
});

it('3: die App-Obergrenze gilt auch für Super-Admins, im Verein und im Verband', async () => {
  await q(`update benutzer set ist_super_admin = true where benutzername = 'admin1'`);
  await gibRolle(t.pool, 'admin1', 'lv_admin', baum.lv);
  const url = `/v2/vereine/${jc}/zugehoerigkeiten`;
  const status = async () => [(await t.api('GET', url, null, await tok('admin1'))).status, (await t.api('GET', url, null, await verbandsToken(t, 'admin1', baum.lv))).status];
  expect(await status()).toEqual([200, 200]);
  await q(`update anwendungen set client_scopes = '{}', scopes = array_remove(scopes, 'benutzer:verwalten') where schluessel = $1`, [CLIENT]);
  expect(await status()).toEqual([404, 404]);
});

it('4: eine Einladung bindet nicht an ein Konto, das die Adresse nie bewiesen hat', async () => {
  await t.api('PATCH', '/ich', { email: 'opfer@example.org' }, await tok('schueler1'));
  const link = await (async () => { mails.length = 0; return einladen('opfer@example.org'); })();
  expect((await annehmen({ token: link })).body).toMatchObject({ status: 400, code: 'angaben_fehlen' });
  expect((await annehmen({ token: link, passwort: 'geraten-123' })).body).toMatchObject({ status: 401, code: 'passwort_falsch' });
  expect((await annehmen({ token: link, benutzername: 'opfer', passwort_neu: PW })).body).toMatchObject({ ok: true, neues_konto: true });
  expect((await t.login('opfer')).body.benutzer).toMatchObject({ email: 'opfer@example.org', vereine: [{ rolle: 'admin' }] });
  expect((await t.login('schueler1')).body.benutzer).toMatchObject({ email: null, vereine: [{ rolle: 'mitglied' }] });
});

it('4: wer das Passwort des Kontos kennt, nimmt mit dem bestehenden Konto an', async () => {
  await t.api('PATCH', '/ich', { email: 'ich@example.org' }, await tok('schueler1'));
  mails.length = 0;
  expect((await annehmen({ token: await einladen('ich@example.org'), passwort: PW })).body).toMatchObject({ ok: true, neues_konto: false });
  expect((await t.login('schueler1')).body.benutzer.vereine[0].rolle).toBe('admin');
});

it('4: Links an eine frühere Adresse bestätigen die neue nicht', async () => {
  const s = await tok('schueler1');
  await t.api('PATCH', '/ich', { email: 'angreifer@example.org' }, s);
  await t.api('POST', '/auth/passwort-vergessen', { kennung: 'schueler1' });
  const [bestaetigen, reset] = mails.map(token);
  await t.api('PATCH', '/ich', { email: 'opfer@example.org' }, s);
  expect((await t.api('POST', '/auth/email-bestaetigen', { token: bestaetigen })).status).toBe(401);
  expect((await t.api('POST', '/auth/passwort-zuruecksetzen', { token: reset, passwort_neu: 'Neues-Passwort-1' })).status).toBe(401);
  expect((await q('select email_bestaetigt_am from benutzer where benutzername = $1', ['schueler1']))[0].email_bestaetigt_am).toBeNull();
});

it('5: Entzug verbraucht offene Einladungen; eine spätere Einladung gilt', async () => {
  const [a, b] = [await einladen('x@example.org'), await einladen('x@example.org')];
  await annehmen({ token: a, benutzername: 'xneu', passwort_neu: PW });
  const [z] = await q('select id, change_seq from benutzer_vereine where benutzer_id = $1', [await uid('xneu')]);
  const r = await t.app.inject({
    method: 'PATCH', url: `/v2/vereine/${jc}/zugehoerigkeiten/${z.id}`, payload: { entscheidung: 'entziehen' },
    headers: { authorization: `Bearer ${await tok('admin1')}`, 'if-match': `"${z.change_seq}"` },
  });
  expect(r.statusCode).toBe(200);
  expect((await annehmen({ token: b })).body).toMatchObject({ status: 401, code: 'link_ungueltig' });
  expect((await q('select status, rolle from benutzer_vereine where id = $1', [z.id]))[0]).toEqual({ status: 'gesperrt', rolle: 'mitglied' });
  expect((await annehmen({ token: await einladen('x@example.org', 'mitglied') })).status).toBe(200);
});

it('6: eine abgemeldete Sitzung eröffnet über verein-wechseln keine neue', async () => {
  const { access_token: at } = (await t.login('admin1')).body;
  await t.api('POST', '/auth/logout', { alle_geraete: true }, at);
  expect((await t.api('POST', '/auth/verein-wechseln', { verein_id: jc }, at)).body).toMatchObject({ status: 401, code: 'abgemeldet' });
});

it('7: Verband verschieben und Verein darunter anlegen verklemmen sich nicht', async () => {
  const ziel = await verbandsbaum(t.pool);
  const a = await t.pool.connect(); const b = await t.pool.connect();
  try {
    await a.query('begin'); await b.query('begin');
    const alt = await organisation.verbandSperren(a, baum.bezirk);
    const { rows: [v] } = await b.query(`insert into vereine (name, verband_id) values ('Gleichzeitig', $1) returning id`, [baum.kreis]);
    const verschoben = organisation.verbandAendern(a, { ...alt, uebergeordnet_id: ziel.lv }); // wartet auf b
    await new Promise((r) => setTimeout(r, 200));
    await b.query('commit');
    await verschoben;
    await a.query('commit');
    const pfad = await q('select vorfahr_id from verband_pfade where nachfahr_id = $1 order by tiefe', [v.id]);
    expect(pfad.map((x) => x.vorfahr_id)).toEqual([baum.kreis, baum.bezirk, ziel.lv, baum.djb]);
  } finally {
    await Promise.all([a, b].map((c) => c.query('rollback').catch(() => {})));
    a.release(); b.release();
  }
});

it('8: abgleich_neu_beginnen() macht Bestandsdaten wieder sichtbar, alte Stände ungültig und lässt change_seq stehen', async () => {
  const app = (await t.api('POST', '/oauth/token', { grant_type: 'client_credentials', client_id: CLIENT, client_secret: cfgDefault.demoClientSecret })).body.access_token;
  const hole = (seit = '') => t.api('GET', `/v1/abgleich?verein_id=${jc}${seit && `&seit=${seit}`}`, null, app);
  const { stand, mitglieder } = (await hole()).body;
  const vorher = await q('select id, change_seq, geaendert_am from mitglieder order by id');
  const c = await t.pool.connect();
  await c.query(`begin; set local session_replication_role = replica; update mitglieder set change_xid = '900000000000'::xid8; commit`);
  c.release();
  expect((await hole()).body.mitglieder).toEqual([]);
  expect((await q('select abgleich_neu_beginnen() n'))[0].n).toBe(1);
  expect((await hole()).body.mitglieder).toHaveLength(mitglieder.length);
  expect((await hole(stand)).body).toMatchObject({ status: 409, code: 'abgleich_neu_starten' });
  expect(await q('select id, change_seq, geaendert_am from mitglieder order by id')).toEqual(vorher);
});
