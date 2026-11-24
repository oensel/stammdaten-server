// Test-Fabrik für den Verbandsbaum. verband_pfade pflegen die Trigger.
import { randomBytes } from 'node:crypto';

const kuerzel = () => randomBytes(4).toString('hex');
const eine = async (db, sql, p) => (await db.query(sql, p)).rows[0].id;

export const verband = (db, typ, uebergeordnet_id, name = `${typ} ${kuerzel()}`) =>
  eine(db, 'insert into verbaende (name, typ, uebergeordnet_id) values ($1,$2,$3) returning id', [name, typ, uebergeordnet_id]);

export const verein = (db, kreisId, name = `Verein ${kuerzel()}`) =>
  eine(db, 'insert into vereine (name, ist_mandant, verband_id) values ($1, true, $2) returning id', [name, kreisId]);

/** Legt LV → Bezirk → Kreis → Verein unter dem (einzigen) DJB an; den DJB nur, wenn er fehlt. Liefert die IDs. */
export async function verbandsbaum(db) {
  // keine App darf Verbände von Haus aus verwalten (App-Obergrenze); im Test die Demo-App schon
  await db.query(`update anwendungen set scopes = scopes || '{verband:verwalten}' where schluessel = 'kyu-manager-pro' and not scopes @> '{verband:verwalten}'`);
  const da = (await db.query(`select id from verbaende where typ = 'dachverband'`)).rows[0]?.id;
  const djb = da ?? await verband(db, 'dachverband', null, 'DJB');
  const lv = await verband(db, 'landesverband', djb);
  const bezirk = await verband(db, 'bezirk', lv);
  const kreis = await verband(db, 'kreis', bezirk);
  return { djb, lv, bezirk, kreis, verein: await verein(db, kreis) };
}

/** Meldet an und wechselt in den Verbandskontext; liefert das Access-Token. */
export async function verbandsToken(t, benutzername, verbandId) {
  const { body } = await t.login(benutzername);
  const r = await t.api('POST', '/v2/auth/kontext-wechseln', { art: 'verband', id: verbandId }, body.access_token);
  if (r.status !== 200) throw new Error(`Kontextwechsel: ${r.status} ${r.body.code}`);
  return r.body.access_token;
}

/** Gibt einem Demo-Zugang eine Verbandsrolle. */
export const gibRolle = (db, benutzername, rolle, verbandId) => db.query(
  'insert into benutzer_verbandsrollen (benutzer_id, verband_id, rolle) select id, $2, $3 from benutzer where benutzername = $1', [benutzername, verbandId, rolle]);
