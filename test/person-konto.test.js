// Story 3.5 (FR-19, FR-76, NFR-4) und Bestätigung fremd vergebener Konten
import { afterEach, beforeEach, expect, it } from 'vitest';
import { verbandsbaum } from './fabrik.js';
import { CLIENT, PW, neueApp } from './helper.js';
import { fuehreAus } from '../src/worker.js';

const PDF = Buffer.from('%PDF-1.7 nachweis');
let t; let jc; let lena; let lenaM; let uhr; let id; let mails;
const q = async (sql, p) => (await t.pool.query(sql, p)).rows;
const tok = async (n, pw = PW) => (await t.login(n, {}, pw)).body.access_token;
beforeEach(async () => {
  uhr = new Date(); mails = [];
  t = await neueApp({ uhr: () => uhr, mailer: { send: async (m) => { mails.push(m); return { ok: true }; } } });
  await verbandsbaum(t.pool);
  await q(`update anwendungen set scopes = scopes || '{mitglieder:schreiben,mitglieder:kontakt}' where schluessel = $1`, [CLIENT]);
  jc = (await q(`select id from vereine where name = 'JC Demo'`))[0].id;
  [{ id: lenaM, person_id: lena }] = await q(`select id, person_id from mitglieder where vorname = 'Lena'`);
  id = Object.fromEntries((await q('select benutzername, id from benutzer')).map((b) => [b.benutzername, b.id]));
  await q(`update benutzer set email = 'eltern@example.org', email_bestaetigt_am = now() - interval '1 day' where benutzername = 'eltern1'`);
  await q('delete from personen_zugriffe');
  await q(`insert into personen_zugriffe (person_id, benutzer_id, art, umfang, erteilt_am) values ($1,$2,'erziehungsberechtigt','aendern',now())`, [lena, id.eltern1]);
  await alter('2014-05-02'); uhr = new Date('2028-05-02T12:00:00Z'); // 14
});
afterEach(() => t.schliessen());

const alter = (d) => q('update personen set geburtsdatum = $2 where id = $1', [lena, d]);
const ohneKonto = () => q('update benutzer_vereine set mitglied_id = null where mitglied_id = $1', [lenaM]);
const url = (x = '') => `/v2/personen/${lena}${x}`;
const konto = async (wer) => t.api('POST', url('/konto'), { benutzername: 'lena.neu' }, await tok(wer));
const ablegen = async (wer) => (await t.app.inject({ method: 'POST', url: url('/dokumente?art=vormundschaftsnachweis'), payload: PDF, headers: { authorization: `Bearer ${await tok(wer)}`, 'content-type': 'application/pdf' } })).json().id;
const erteile = async (wer, b) => t.api('POST', url('/zugriffe'), { umfang: 'lesen', ...b }, await tok(wer));
const NEU = 'noch-ein-neues-Passwort-88';
const bestaetige = (token) => t.api('POST', '/v2/auth/konto-bestaetigen', { token, passwort_neu: NEU });
const linkToken = () => /#token=(\S+)/.exec(mails.at(-1).text)[1];
/** Anmelden mit Startpasswort, eigenes setzen, neu anmelden. */
async function uebernehmen(name, start) {
  const pw = 'ein-ganz-eigenes-Passwort-77';
  expect((await t.api('PATCH', '/ich', { passwort_alt: start, passwort_neu: pw }, await tok(name, start))).status).toBe(200);
  return tok(name, pw);
}

it('Konto ab 14 durch Eltern oder Heimatverein, sonst niemand; unter 14 abgewiesen', async () => {
  expect((await konto('admin1')).body.code).toBe('konto_vorhanden');
  await ohneKonto();
  uhr = new Date('2028-05-01T12:00:00Z');
  expect((await konto('eltern1')).body.code).toBe('zu_jung');
  uhr = new Date('2028-05-02T12:00:00Z');
  for (const wer of ['trainer1', 'pruefer1']) expect((await konto(wer)).status).toBe(404);
  const r = await konto('eltern1');
  expect(r.status).toBe(201);
  expect(r.body.startpasswort).toBeTruthy();
  expect(await q('select benutzer_id from personen where id = $1', [lena])).toEqual([{ benutzer_id: r.body.benutzer_id }]);
  expect(await q(`select benutzer_id from audit_log where aktion = 'recht_vergeben' and objekt_art = 'vereinszugehoerigkeit'`)).toEqual([{ benutzer_id: id.eltern1 }]);
  expect((await konto('admin1')).body.code).toBe('konto_vorhanden');
});

it('mit fremdem Startpasswort gibt es Personenrechte erst nach der Bestätigung', async () => {
  await ohneKonto();
  await ablegen('admin1');
  const { body } = await konto('admin1');
  let token = await uebernehmen('lena.neu', body.startpasswort);
  expect((await t.api('GET', url(), null, token)).status).toBe(200); // Lesen bleibt
  const docs = async () => (await t.api('GET', url('/dokumente'), null, token)).body.dokumente.length;
  expect(await docs()).toBe(0);
  const telefon = async () => {
    const [{ change_seq }] = await q('select change_seq from personen where id = $1', [lena]);
    return (await t.app.inject({ method: 'PATCH', url: url('/kontakt'), payload: { telefon: '1' }, headers: { authorization: `Bearer ${token}`, 'if-match': `"${change_seq}"` } })).statusCode;
  };
  expect(await telefon()).toBe(422);
  await q('update personen set email = null where id = $1', [lena]);
  expect((await t.api('POST', '/v2/ich/konto-bestaetigung', null, token)).status).toBe(202);
  expect(mails.at(-1).to).toBe('eltern@example.org');
  const l = linkToken();
  expect((await bestaetige(`${l.slice(0, -1)}_`)).status).toBe(404);
  expect((await t.api('POST', '/v2/auth/konto-bestaetigen', { token: l, passwort_neu: 'kurz' })).status).toBe(400);
  expect((await bestaetige(l)).status).toBe(200);
  expect((await bestaetige(l)).status).toBe(404);
  // Passwort und Sitzung des Vergebenden gelten nicht weiter
  expect((await t.login('lena.neu', {}, 'ein-ganz-eigenes-Passwort-77')).status).toBe(401);
  expect(await q('select 1 from refresh_tokens where benutzer_id = $1 and widerrufen_am is null', [body.benutzer_id])).toEqual([]);
  token = await tok('lena.neu', NEU);
  expect(await docs()).toBe(1);
  expect(await telefon()).toBe(200);
  expect((await q(`select 1 from audit_log where objekt_art = 'konto' and objekt_id = $1`, [body.benutzer_id])).length).toBe(1);
  expect((await t.api('POST', '/v2/ich/konto-bestaetigung', null, token)).body.code).toBe('schon_bestaetigt');
});

it('der Vergebende kann die Bestätigung nicht auf seine Adresse lenken; ohne sichere Adresse keine', async () => {
  await ohneKonto();
  await alter('2000-01-01'); // volljährig: keine Eltern
  const { body } = await konto('admin1');
  const token = await uebernehmen('lena.neu', body.startpasswort);
  await q(`update personen set email = 'trick@example.org', geaendert_von = $2 where id = $1`, [lena, id.admin1]);
  await t.api('PATCH', '/ich', { email: 'trick2@example.org' }, token);
  await q(`update benutzer set email_bestaetigt_am = now() where id = $1`, [body.benutzer_id]);
  expect((await t.api('POST', '/v2/ich/konto-bestaetigung', null, token)).body.code).toBe('adresse_fehlt');
  expect((await t.api('POST', url('/zugriffe'), { benutzer_id: id.pruefer1, art: 'bevollmaechtigt', umfang: 'lesen' }, token)).status).toBe(404);
  await q(`update personen set email = 'echt@example.org', geaendert_von = null where id = $1`, [lena]);
  expect((await t.api('POST', '/v2/ich/konto-bestaetigung', null, token)).status).toBe(202);
  expect(mails.at(-1).to).toBe('echt@example.org');
  // ein neuer fremder Reset entwertet den offenen Link
  expect((await t.api('POST', `/benutzer/${body.benutzer_id}/passwort-zuruecksetzen`, null, await tok('admin1'))).status).toBe(200);
  expect((await bestaetige(linkToken())).status).toBe(404);
});

it('nach dem Reset eines Elternkontos ruhen dessen Personenrechte bis zur Bestätigung an die alte Adresse', async () => {
  await ablegen('admin1');
  const { body } = await t.api('POST', `/benutzer/${id.eltern1}/passwort-zuruecksetzen`, null, await tok('trainer1'));
  let token = await uebernehmen('eltern1', body.startpasswort);
  expect((await t.api('DELETE', url(`/zugriffe/${(await q('select id from personen_zugriffe'))[0].id}`), null, token)).status).toBe(404);
  expect((await t.api('GET', url('/dokumente'), null, token)).body.dokumente).toEqual([]);
  expect((await t.api('POST', url('/zugriffe'), { benutzer_id: id.pruefer1, art: 'bevollmaechtigt', umfang: 'lesen' }, token)).status).toBe(404);
  for (let i = 0; i < 3; i++) expect((await t.api('POST', '/v2/ich/konto-bestaetigung', null, token)).status).toBe(202);
  expect((await t.api('POST', '/v2/ich/konto-bestaetigung', null, token)).status).toBe(429);
  expect((await bestaetige(linkToken())).status).toBe(200);
  token = await tok('eltern1', NEU);
  expect((await t.api('GET', url('/dokumente'), null, token)).body.dokumente).toHaveLength(1);
});

it('ein zweiter Reset macht die Adresse des Vergebenden nicht sicher; nach der Bestätigung gilt wieder die alte', async () => {
  const reset = async () => (await t.api('POST', `/benutzer/${id.eltern1}/passwort-zuruecksetzen`, null, await tok('trainer1'))).body.startpasswort;
  let token = await uebernehmen('eltern1', await reset());
  expect((await t.api('PATCH', '/ich', { email: 'trick@example.org' }, token)).status).toBe(200);
  expect((await t.api('POST', '/auth/email-bestaetigen', { token: linkToken() })).status).toBe(200);
  const start = await reset();
  await t.api('PATCH', '/ich', { passwort_alt: start, passwort_neu: 'wieder-ein-anderes-Passwort-9' }, await tok('eltern1', start));
  token = await tok('eltern1', 'wieder-ein-anderes-Passwort-9');
  expect((await t.api('POST', '/v2/ich/konto-bestaetigung', null, token)).status).toBe(202);
  expect(mails.at(-1).to).toBe('eltern@example.org');
  expect((await bestaetige(linkToken())).status).toBe(200);
  expect(await q('select email from benutzer where id = $1', [id.eltern1])).toEqual([{ email: 'eltern@example.org' }]);
});

it('weder der anlegende Elternteil noch ein Zweitkonto des Vergebenden erhält den Link', async () => {
  await ohneKonto();
  await q('update personen set email = null where id = $1', [lena]);
  const { body } = await konto('eltern1');
  const token = await uebernehmen('lena.neu', body.startpasswort);
  const fordere = async () => (await t.api('POST', '/v2/ich/konto-bestaetigung', null, token)).body.code;
  expect(await fordere()).toBe('adresse_fehlt');
  // Zweitkonto: vom Vergebenden berechtigt, mit bestätigter Adresse; auch als Setzer der Adresse der Person
  await q(`update benutzer set email = 'zweit@example.org', email_bestaetigt_am = now() where id = $1`, [id.pruefer1]);
  await q(`insert into personen_zugriffe (person_id, benutzer_id, art, umfang, erteilt_von, erteilt_am) values ($1,$2,'erziehungsberechtigt','aendern',$3,now())`, [lena, id.pruefer1, id.eltern1]);
  expect(await fordere()).toBe('adresse_fehlt');
  await q(`update personen set email = 'zweit@example.org', geaendert_von = $2 where id = $1`, [lena, id.pruefer1]);
  expect(await fordere()).toBe('adresse_fehlt');
});

it('eine Einladung verknüpft die Person nur unbestätigt, außer die Adresse hat jemand anderes bei ihr hinterlegt', async () => {
  await alter('2000-01-01');
  await ohneKonto();
  const lade = async (email, benutzername) => {
    expect((await t.api('POST', '/einladungen', { email, mitglied_id: lenaM }, await tok('admin1'))).status).toBe(202);
    expect((await t.api('POST', '/auth/einladung-annehmen', { token: linkToken(), benutzername, passwort_neu: NEU })).status).toBe(200);
    return tok(benutzername, NEU);
  };
  const erteilen = async (token) => (await t.api('POST', url('/zugriffe'), { benutzer_id: id.pruefer1, art: 'bevollmaechtigt', umfang: 'lesen' }, token)).status;
  await q(`update personen set email = 'trick@example.org', geaendert_von = $2 where id = $1`, [lena, id.admin1]);
  let token = await lade('trick@example.org', 'lena.trick');
  expect(await q('select benutzer_id from personen where id = $1', [lena])).toEqual(await q(`select id as benutzer_id from benutzer where benutzername = 'lena.trick'`));
  expect(await erteilen(token)).toBe(404);
  expect((await t.api('POST', '/v2/ich/konto-bestaetigung', null, token)).body.code).toBe('adresse_fehlt');
  // nur die Person ist unbestätigt, nicht das Konto
  expect(await q(`select fremd_vergeben_am from benutzer where benutzername = 'lena.trick'`)).toEqual([{ fremd_vergeben_am: null }]);
  await q(`update personen set email = 'echt@example.org', geaendert_von = null where id = $1`, [lena]);
  expect((await t.api('POST', '/v2/ich/konto-bestaetigung', null, token)).status).toBe(202);
  expect(mails.at(-1).to).toBe('echt@example.org');
  expect((await bestaetige(linkToken())).status).toBe(200);
  expect(await q(`select email from benutzer where benutzername = 'lena.trick'`)).toEqual([{ email: 'echt@example.org' }]);
  expect(await erteilen(await tok('lena.trick', NEU))).toBe(201);
  await q('delete from personen_zugriffe where benutzer_id = $1', [id.pruefer1]);
  await ohneKonto();
  await q(`update personen set email = 'lena@example.org', geaendert_von = null where id = $1`, [lena]);
  token = await lade('lena@example.org', 'lena.echt');
  expect(await erteilen(token)).toBe(201);
});

it('Elternrechte bleiben, wenn eine Einladung das Konto mit der eigenen Person verknüpft', async () => {
  const [{ id: thomas, person_id: tp }] = await q(`select id, person_id from mitglieder where vorname = 'Thomas'`);
  await q('update benutzer_vereine set mitglied_id = null where mitglied_id = $1', [thomas]);
  await q(`update personen set geburtsdatum = '1980-01-01' where id = $1`, [tp]);
  expect((await t.api('POST', '/einladungen', { email: 'eltern@example.org', mitglied_id: thomas }, await tok('admin1'))).status).toBe(202);
  expect((await t.api('POST', '/auth/einladung-annehmen', { token: linkToken(), passwort: PW })).status).toBe(200);
  expect(await q('select konto_unbestaetigt_seit is not null as offen from personen where id = $1', [tp])).toEqual([{ offen: true }]);
  const token = await tok('eltern1');
  expect((await t.api('GET', url('/dokumente'), null, token)).status).toBe(200);
  expect((await erteile('eltern1', { benutzer_id: id.pruefer1, art: 'bevollmaechtigt' })).status).toBe(201);
  expect((await t.api('POST', `/v2/personen/${tp}/zugriffe`, { benutzer_id: id.pruefer1, art: 'bevollmaechtigt', umfang: 'lesen' }, token)).status).toBe(404);
});

it('mit 18 weist die Jahresfrage auf ein von den Eltern gesetztes Passwort hin', async () => {
  await ohneKonto();
  await q('update personen set email = null where id = $1', [lena]);
  await q(`update benutzer set email = 'eltern2@example.org', email_bestaetigt_am = now() where id = $1`, [id.pruefer1]);
  await q(`insert into personen_zugriffe (person_id, benutzer_id, art, umfang, erteilt_am) values ($1,$2,'erziehungsberechtigt','aendern',now())`, [lena, id.pruefer1]);
  const { body } = await konto('eltern1');
  const token = await uebernehmen('lena.neu', body.startpasswort);
  expect((await t.api('POST', '/v2/ich/konto-bestaetigung', null, token)).status).toBe(202);
  expect(mails.at(-1).to).toBe('eltern2@example.org');
  expect((await bestaetige(linkToken())).status).toBe(200);
  uhr = new Date('2032-05-02T12:00:00Z');
  const s = await tok('lena.neu', NEU);
  expect((await t.api('GET', url('/zugriffsabfrage'), null, s)).body.passwort_aendern).toBe(true);
  await t.api('PATCH', '/ich', { passwort_alt: NEU, passwort_neu: 'jetzt-mein-eigenes-Passwort-1' }, s);
  expect((await t.api('GET', url('/zugriffsabfrage'), null, await tok('lena.neu', 'jetzt-mein-eigenes-Passwort-1'))).body.passwort_aendern).toBe(false);
});

it('Vormund nur durch den Heimatverein mit bestätigtem Nachweis', async () => {
  const b = { benutzer_id: id.pruefer1, art: 'vormund' };
  expect((await erteile('admin1', b)).body.code).toBe('nachweis_fehlt');
  const nachweis_id = await ablegen('admin1');
  expect((await erteile('admin1', { ...b, nachweis_id })).body.code).toBe('nachweis_fehlt');
  const best = async (wer) => (await t.api('POST', url(`/dokumente/${nachweis_id}/bestaetigen`), null, await tok(wer))).status;
  for (const wer of ['eltern1', 'trainer1', 'schueler1']) expect(await best(wer)).toBe(404);
  expect(await best('admin1')).toBe(200);
  expect((await erteile('eltern1', { ...b, nachweis_id })).status).toBeGreaterThanOrEqual(404);
  expect((await erteile('admin1', { ...b, nachweis_id })).status).toBe(201);
  await expect(q(`insert into personen_zugriffe (person_id, benutzer_id, art, umfang, erteilt_am) values ($1,$2,'vormund','lesen',now())`, [lena, id.trainer1])).rejects.toMatchObject({ constraint: 'vormund_braucht_nachweis' });
});

it('mit 18 ruhen alle Zugriffe außer dem Vormund; die Jahresfrage schaltet frei oder beendet', async () => {
  const nachweis_id = await ablegen('admin1');
  await t.api('POST', url(`/dokumente/${nachweis_id}/bestaetigen`), null, await tok('admin1'));
  await q(`insert into personen_zugriffe (person_id, benutzer_id, art, umfang, erteilt_am, nachweis_id) values ($1,$2,'vormund','lesen',now(),$3)`, [lena, id.pruefer1, nachweis_id]);
  await q(`insert into personen_zugriffe (person_id, benutzer_id, art, umfang, erteilt_am) values ($1,$2,'bevollmaechtigt','lesen',now())`, [lena, id.trainer1]);
  const lauf = (jetzt) => fuehreAus(t.pool, 'volljaehrigkeit', {}, { jetzt });
  expect(await lauf(new Date('2032-05-01T12:00:00Z'))).toEqual({ ruhend: 0 });
  expect(await lauf(new Date('2032-05-02T12:00:00Z'))).toEqual({ ruhend: 2 });
  expect(await lauf(new Date('2032-05-02T13:00:00Z'))).toEqual({ ruhend: 0 });
  uhr = new Date('2032-05-02T12:00:00Z');
  expect(await q('select benutzer_id from personen_zugriffe where ruht_seit is null')).toEqual([{ benutzer_id: id.pruefer1 }]);
  expect(await q('select 1 from personen_zugriffe where widerrufen_am is not null')).toEqual([]);
  expect((await q(`select 1 from audit_log where grund = 'Zugriff ruht ab 18'`)).length).toBe(2);
  expect((await q(`select 1 from erziehungsberechtigte where mitglied_id = $1 and geloescht_am is null`, [lenaM]))).toEqual([]); // /v1
  expect((await t.api('GET', url(), null, await tok('eltern1'))).status).toBe(404);
  expect((await t.api('GET', url(), null, await tok('pruefer1'))).status).toBe(200);
  // Jahresfrage
  const s = await tok('schueler1');
  const frage = async () => (await t.api('GET', url('/zugriffsabfrage'), null, s)).body;
  const { faellig, zugriffe } = await frage();
  expect(faellig).toBe(true);
  expect(zugriffe.map((z) => z.benutzer_id).sort()).toEqual([id.eltern1, id.trainer1].sort());
  const antwort = (entscheidungen) => t.api('POST', url('/zugriffsabfrage'), { entscheidungen }, s);
  expect((await antwort([])).body.code).toBe('entscheidung_fehlt');
  expect((await antwort(zugriffe.map((z) => ({ zugriff_id: z.id, behalten: z.benutzer_id === id.eltern1 })))).status).toBe(200);
  expect((await t.api('GET', url(), null, await tok('eltern1'))).status).toBe(200);
  expect(await q('select benutzer_id from personen_zugriffe where widerrufen_am is not null')).toEqual([{ benutzer_id: id.trainer1 }]);
  expect((await q(`select aktion from audit_log where grund = 'Jahresfrage' order by aktion`)).map((r) => r.aktion)).toEqual(['recht_entzogen', 'recht_vergeben']);
  expect((await frage()).faellig).toBe(false);
  uhr = new Date('2033-05-02T12:00:00Z');
  expect((await frage()).faellig).toBe(true);
  expect((await t.api('GET', url('/zugriffsabfrage'), null, await tok('eltern1'))).status).toBe(404);
});
