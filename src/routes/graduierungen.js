// Graduierungen zurückschreiben (Apps per Client-Credentials): POST /v1/graduierungen, DELETE /v1/graduierungen/:id
// quelle = Schlüssel der App; geaendert_von bleibt leer (kein Benutzer). Änderungen kommen über /v1/abgleich zurück.
import { badRequest, conflict, fehler, forbidden } from '../errors.js';
import { pruefeAnwendungsToken } from '../auth.js';
import { tx } from '../db.js';

const QUELLEN = ['manuell', 'import', 'dojo-master-pro', 'kyu-manager-pro']; // check-Constraint in graduierungen.quelle

const ausgabe = (g) => ({ id: g.id, mitglied_id: g.mitglied_id, art: g.art, stufe: g.stufe, datum: g.datum, quelle: g.quelle });

export default async function graduierungenRoutes(app) {
  const pool = app.pool;

  app.post('/v1/graduierungen', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['verein_id', 'mitglied_id', 'art', 'stufe', 'datum'],
        properties: {
          verein_id: { type: 'string', format: 'uuid' }, mitglied_id: { type: 'string', format: 'uuid' },
          art: { type: 'string', enum: ['kyu', 'dan'] }, stufe: { type: 'integer', minimum: 1, maximum: 10 },
          datum: { type: 'string', format: 'date' }, ort: { type: ['string', 'null'], maxLength: 200 }, pruefer: { type: ['string', 'null'], maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body;
    const { anw } = await pruefeAnwendungsToken(app, req, { vereinId: b.verein_id, scope: 'graduierungen:schreiben' });
    if (!QUELLEN.includes(anw.schluessel)) throw forbidden('Diese Anwendung darf keine Graduierungen schreiben', 'quelle_nicht_erlaubt');
    if (b.art === 'kyu' && b.stufe > 9) throw badRequest('Kyu-Stufen gehen von 1 bis 9', 'stufe_ungueltig');

    const mitglied = (await pool.query(
      'select 1 from mitglieder where id = $1 and verein_id = $2 and geloescht_am is null and anonymisiert_am is null', [b.mitglied_id, b.verein_id])).rows[0];
    if (!mitglied) throw fehler(404, 'Mitglied nicht im Verein', 'mitglied_unbekannt');

    const ort = b.ort ?? null; const pruefer = b.pruefer ?? null;
    // zwei Versuche: bei gleichzeitigem Anlegen derselben Stufe greift der Unique-Constraint, dann gilt der Bestand
    for (let versuch = 0; versuch < 2; versuch++) {
      try {
        // Antwort erst NACH dem Commit senden (sonst sieht der Aufrufer die Zeile womöglich noch nicht)
        const { status, body } = await tx(pool, async (db) => {
          const alt = (await db.query(
            'select * from graduierungen where mitglied_id = $1 and art = $2 and stufe = $3 for update', [b.mitglied_id, b.art, b.stufe])).rows[0];
          if (!alt) {
            const g = (await db.query(
              `insert into graduierungen (verein_id, mitglied_id, art, stufe, datum, ort, pruefer, quelle)
               values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
              [b.verein_id, b.mitglied_id, b.art, b.stufe, b.datum, ort, pruefer, anw.schluessel])).rows[0];
            return { status: 201, body: ausgabe(g) };
          }
          if (alt.geloescht_am || alt.quelle === anw.schluessel) {
            const unveraendert = !alt.geloescht_am && alt.datum === b.datum && alt.ort === ort && alt.pruefer === pruefer;
            if (unveraendert) return { status: 200, body: ausgabe(alt) };
            const g = (await db.query(
              `update graduierungen set datum = $2, ort = $3, pruefer = $4, quelle = $5, geloescht_am = null, geaendert_am = now(), geaendert_von = null
                where id = $1 returning *`, [alt.id, b.datum, ort, pruefer, anw.schluessel])).rows[0];
            return { status: 200, body: ausgabe(g) };
          }
          if (alt.datum === b.datum) return { status: 200, body: ausgabe(alt) }; // andere Quelle, gleiches Datum: idempotent
          throw conflict('Diese Graduierung gibt es schon (andere Quelle, anderes Datum)', 'graduierung_vorhanden', { id: alt.id, datum: alt.datum });
        });
        return reply.code(status).send(body);
      } catch (e) {
        if (e.code === '23505' && versuch === 0) continue;
        throw e;
      }
    }
    return undefined;
  });

  app.delete('/v1/graduierungen/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', required: ['verein_id'], properties: { verein_id: { type: 'string', format: 'uuid' } } },
    },
  }, async (req, reply) => {
    const { anw } = await pruefeAnwendungsToken(app, req, { vereinId: req.query.verein_id, scope: 'graduierungen:schreiben' });
    const g = (await pool.query('select id, quelle, geloescht_am from graduierungen where id = $1 and verein_id = $2', [req.params.id, req.query.verein_id])).rows[0];
    if (!g) throw fehler(404, 'Graduierung unbekannt', 'graduierung_unbekannt');
    if (g.quelle !== anw.schluessel) throw forbidden('Diese Graduierung stammt aus einer anderen Quelle', 'fremde_quelle');
    if (!g.geloescht_am) {
      await pool.query('update graduierungen set geloescht_am = now(), geaendert_am = now(), geaendert_von = null where id = $1', [g.id]);
    }
    return reply.code(204).send();
  });
}
