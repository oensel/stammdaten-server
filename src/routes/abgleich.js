// Server-zu-Server-Abgleich (api-entwurf.md 5.1): GET /v1/abgleich?verein_id=&seit=&limit=
// Nur Client-Credentials-Tokens (Apps), nur Vereine aus anwendung_vereine, nur Felder innerhalb der client_scopes der App.
//
// Cursor: change_xid (siehe schema.sql Abschnitt 8). Obergrenze der Abfrage = pg_snapshot_xmin(pg_current_snapshot()):
// alle Transaktionen darunter sind abgeschlossen, laufende Schreibvorgänge werden also erst im nächsten Abruf geliefert
// und gehen nie verloren. `stand` = „Transaktionsnummer, ab der der nächste Abruf beginnt“ + Fingerabdruck der App-Obergrenze.
import { createHash } from 'node:crypto';
import { conflict } from '../errors.js';
import { pruefeAnwendungsToken } from '../auth.js';

const VERSION = '1';

const hashObergrenze = (a) => createHash('sha256')
  .update(JSON.stringify([[...a.client_scopes].sort(), a.lizenz_arten ? [...a.lizenz_arten].sort() : null]))
  .digest('hex').slice(0, 12);
const stand = (x, hash) => Buffer.from(`${VERSION}.${x}.${hash}`).toString('base64url');
const leseStand = (s, hash) => {
  const m = /^(\d+)\.(\d{1,19})\.([0-9a-f]{12})$/.exec(Buffer.from(s, 'base64url').toString());
  return m && m[1] === VERSION && m[3] === hash ? m[2] : null;
};
const X = 'change_xid::text::bigint';

export default async function abgleichRoutes(app) {
  const pool = app.pool;

  app.get('/v1/abgleich', {
    schema: {
      querystring: {
        type: 'object', required: ['verein_id'],
        properties: {
          verein_id: { type: 'string', format: 'uuid' }, seit: { type: 'string', maxLength: 100 },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
        },
      },
    },
  }, async (req, reply) => {
    const { verein_id: vereinId, seit, limit } = req.query;
    const { anw } = await pruefeAnwendungsToken(app, req, { vereinId });

    const hash = hashObergrenze(anw);
    let von = '0';
    if (seit) {
      von = leseStand(seit, hash);
      if (von === null) throw conflict('Der Abgleich muss neu gestartet werden (Stand ungültig oder Obergrenze der Anwendung geändert)', 'abgleich_neu_starten');
    }
    const bis = (await pool.query('select pg_snapshot_xmin(pg_current_snapshot())::text::bigint::text as bis')).rows[0].bis;
    if (BigInt(von) > BigInt(bis)) throw conflict('Der Stand liegt in der Zukunft – Abgleich neu starten', 'abgleich_neu_starten');

    const s = new Set(anw.client_scopes);
    const ausgetretene = s.has('mitglieder:ausgetretene');
    const tabellen = [];
    if (s.has('mitglieder:lesen')) {
      tabellen.push({
        name: 'mitglieder',
        sql: `select id, mitgliedsnr, vorname, nachname, ${s.has('mitglieder:person') ? 'geburtsdatum,' : ''} status, geloescht_am, anonymisiert_am, ${X} as _x
                from mitglieder where verein_id = $1`,
      });
    }
    if (s.has('gruppen:lesen')) {
      tabellen.push({ name: 'gruppen', sql: `select id, name, sortierung, trainingszeiten, geloescht_am, ${X} as _x from gruppen where verein_id = $1` });
      tabellen.push({ name: 'mitglied_gruppen', sql: `select mitglied_id, gruppe_id, geloescht_am, ${X} as _x from mitglied_gruppen where verein_id = $1` });
    }
    if (s.has('graduierungen:lesen')) {
      tabellen.push({
        name: 'graduierungen',
        sql: `select id, mitglied_id, art, stufe, datum, urkunden_nr, quelle, geloescht_am, ${X} as _x from graduierungen where verein_id = $1`,
      });
    }
    if (s.has('lizenzen:lesen') || s.has('lizenzen:judopass')) {
      tabellen.push({
        name: 'lizenzen', arten: anw.lizenz_arten,
        sql: `select id, mitglied_id, art, nummer, gueltig_bis, geloescht_am, ${X} as _x from lizenzen where verein_id = $1
                and ($4::text[] is null or art = any($4::text[]))`,
      });
    }

    // Zeilen mit von <= change_xid <= obergrenze (inklusive); max = 0 → ohne Limit
    const hole = (t, obergrenze, max) => pool.query(
      `${t.sql} and ${X} >= $2::bigint and ${X} <= $3::bigint order by _x${max ? ` limit ${max}` : ''}`,
      t.name === 'lizenzen' ? [vereinId, von, obergrenze, t.arten] : [vereinId, von, obergrenze]);

    const letzte = (BigInt(bis) - 1n).toString(); // bis selbst ist exklusiv (Transaktion evtl. noch offen)
    const probe = await Promise.all(tabellen.map((t) => hole(t, letzte, limit + 1)));
    const alle = probe.flatMap((r) => r.rows.map((x) => BigInt(x._x))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let ergebnis = probe; let naechster = bis; let mehr = false;
    if (alle.length > limit) {
      // die ersten `limit` Zeilen; eine angefangene Transaktion wird komplett geliefert (Antwort kann dadurch größer sein)
      const schnitt = alle[limit - 1];
      ergebnis = await Promise.all(tabellen.map((t) => hole(t, schnitt.toString(), 0)));
      naechster = (schnitt + 1n).toString();
      mehr = true;
    }

    const antwort = { stand: stand(naechster, hash), mehr, mitglieder: [], gruppen: [], mitglied_gruppen: [], graduierungen: [], lizenzen: [] };
    tabellen.forEach((t, i) => {
      antwort[t.name] = ergebnis[i].rows.map(({ _x, ...zeile }) => {
        // ohne Scope mitglieder:ausgetretene nur der Hinweis „ausgetreten“ (kein Name), damit die App den Eintrag deaktivieren kann
        if (t.name === 'mitglieder' && !ausgetretene && zeile.status === 'ausgetreten') {
          return { ...zeile, vorname: null, nachname: null, ...('geburtsdatum' in zeile ? { geburtsdatum: null } : {}) };
        }
        return zeile;
      });
    });
    reply.header('Cache-Control', 'no-store');
    return antwort;
  });
}
