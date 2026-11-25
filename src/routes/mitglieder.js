// Mitglieder: Eintrittsdatum (nur Dojo-Master-Pro), Passfoto (Formular-Upload), Import aus dem DJB-Portal-Export (alle Apps, Admin mit Scope mitglieder:import) + Lesen (Feldgruppen nach Scope).
//   POST /mitglieder/import?pruefen=true   Body: text/csv oder xlsx (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet)
//   GET  /mitglieder, GET /mitglieder/:id
import multipart from '@fastify/multipart';
import { badRequest, forbidden, notFound } from '../errors.js';
import { pruefeBearer } from '../auth.js';
import { tx } from '../db.js';
import { alsObjekte, importiere, parseCsv, parseXlsx } from '../import.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const IMPORT_LIMIT = 20 * 1024 * 1024;

export default async function mitgliederRoutes(app) {
  const pool = app.pool;
  const scopes = (claims) => new Set((claims.scope || '').split(' ').filter(Boolean));
  const braucht = (claims, scope) => { if (!scopes(claims).has(scope)) throw forbidden('Dafür fehlt die Berechtigung', 'scope_fehlt'); };
  const verein = (claims, query) => {
    const id = claims.verein_id || (claims.super_admin ? query?.verein_id : null);
    if (!id) throw badRequest('Kein Vereinskontext im Token', 'verein_fehlt');
    return id;
  };

  // Rohdaten der Datei: CSV als Text, xlsx/Binär als Buffer (nur in diesem Plugin)
  app.addContentTypeParser('text/csv', { parseAs: 'string', bodyLimit: IMPORT_LIMIT }, (req, body, done) => done(null, body));
  app.addContentTypeParser([XLSX, 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: IMPORT_LIMIT }, (req, body, done) => done(null, body));

  app.post('/mitglieder/import', {
    bodyLimit: IMPORT_LIMIT,
    schema: { querystring: { type: 'object', properties: { pruefen: { type: 'boolean' }, verein_id: { type: 'string', format: 'uuid' } } } },
  }, async (req) => {
    const claims = await pruefeBearer(app, req);
    braucht(claims, 'mitglieder:import');
    const vereinId = verein(claims, req.query);
    const body = req.body;
    if (!body || !(typeof body === 'string' || Buffer.isBuffer(body))) {
      throw badRequest('Datei als Body senden (Content-Type text/csv oder xlsx)', 'datei_fehlt');
    }
    const zeilen = typeof body === 'string' ? parseCsv(body) : await parseXlsx(body);
    const daten = alsObjekte(zeilen);
    const pruefen = !!req.query.pruefen;
    class Trockenlauf extends Error {}
    let bericht;
    try {
      await tx(pool, async (db) => {
        bericht = await importiere(db, vereinId, daten, claims.sub);
        if (pruefen) throw new Trockenlauf();
      });
    } catch (e) {
      if (!(e instanceof Trockenlauf)) throw e;
    }
    return { trockenlauf: pruefen, ...bericht };
  });

  /* ---------- Lesen ---------- */
  const SPALTEN = {
    kern: ['id', 'mitgliedsnr', 'vorname', 'nachname', 'status'],
    person: ['geburtsdatum', 'geschlecht', 'nationalitaet'],
    kontakt: ['strasse', 'plz', 'ort', 'land', 'email', 'telefon'],
    mitgliedschaft: ['eintritt', 'kuendigung_am', 'austritt', 'ehrenmitglied', 'djb_id'],
  };
  const spaltenFuer = (s) => [
    ...SPALTEN.kern, ...(s.has('mitglieder:person') ? SPALTEN.person : []), ...(s.has('mitglieder:kontakt') ? SPALTEN.kontakt : []),
    ...(s.has('mitglieder:mitgliedschaft') ? SPALTEN.mitgliedschaft : []),
  ];

  app.get('/mitglieder', {
    schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['aktiv', 'ruhend', 'ausgetreten'] }, verein_id: { type: 'string', format: 'uuid' } } } },
  }, async (req) => {
    const claims = await pruefeBearer(app, req);
    braucht(claims, 'mitglieder:lesen');
    const s = scopes(claims);
    const vereinId = verein(claims, req.query);
    if (req.query.status === 'ausgetreten' && !s.has('mitglieder:ausgetretene')) throw forbidden('Dafür fehlt die Berechtigung', 'scope_fehlt');
    const r = await pool.query(
      `select ${spaltenFuer(s).join(', ')} from mitglieder where verein_id = $1 and geloescht_am is null
         and anonymisiert_am is null and ($2::text is null or status = $2) and ($3 or status <> 'ausgetreten')
       order by nachname, vorname`,
      [vereinId, req.query.status || null, s.has('mitglieder:ausgetretene')]);
    return { anzahl: r.rowCount, mitglieder: r.rows };
  });

  app.get('/mitglieder/:id', { schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } } }, async (req) => {
    const claims = await pruefeBearer(app, req);
    const s = scopes(claims);
    const vereinId = verein(claims, req.query);
    const eigene = (claims.mitglied_ids || []).includes(req.params.id);
    if (!s.has('mitglieder:lesen') && !(s.has('mitglieder:selbst') && eigene)) throw forbidden('Dafür fehlt die Berechtigung', 'scope_fehlt');
    const sp = s.has('mitglieder:lesen') ? spaltenFuer(s) : [...SPALTEN.kern, ...SPALTEN.person, ...SPALTEN.kontakt];
    const m = (await pool.query(
      `select ${sp.join(', ')} from mitglieder where id = $1 and verein_id = $2 and geloescht_am is null and anonymisiert_am is null
         and ($3 or status <> 'ausgetreten')`, [req.params.id, vereinId, s.has('mitglieder:ausgetretene') || eigene])).rows[0];
    if (!m) throw notFound();
    if (s.has('graduierungen:lesen')) {
      m.graduierungen = (await pool.query(
        `select art, stufe, datum, urkunden_nr from graduierungen where mitglied_id = $1 and geloescht_am is null order by art desc, stufe`,
        [m.id])).rows;
    }
    return m;
  });

  /* ---------- Eintrittsdatum: nur Dojo-Master-Pro (Scope mitglieder:eintritt) ---------- */
  const idParam = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } };
  app.patch('/mitglieder/:id', {
    schema: {
      params: idParam,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { eintritt: { type: ['string', 'null'], format: 'date' } } },
    },
  }, async (req) => {
    const claims = await pruefeBearer(app, req);
    braucht(claims, 'mitglieder:eintritt');
    const r = await pool.query(
      `update mitglieder set eintritt = $3, geaendert_am = now(), geaendert_von = $4
        where id = $1 and verein_id = $2 and geloescht_am is null and anonymisiert_am is null returning id, eintritt`,
      [req.params.id, verein(claims, req.query), req.body.eintritt, claims.sub]);
    if (!r.rows[0]) throw notFound();
    return r.rows[0];
  });

  /* ---------- Passfoto: Upload per Formular (multipart/form-data, Feld „datei“) oder direkt als Bild ---------- */
  const FOTO_MAX = 5 * 1024 * 1024;
  await app.register(multipart, { limits: { fileSize: FOTO_MAX, files: 1, fields: 5 } });
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: FOTO_MAX }, (req, body, done) => done(null, body));

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bildTyp = (b) => {
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['image/jpeg', 'jpg'];
    if (b.length > 8 && b.subarray(0, 8).equals(PNG)) return ['image/png', 'png'];
    if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return ['image/webp', 'webp'];
    return null;
  };
  /** Zugriff auf das Passfoto: eigenes Mitglied/Kind (mitglieder:selbst) oder Scope; Mitglied muss im Verein des Tokens liegen. */
  const fotoZugriff = async (req, schreiben) => {
    const claims = await pruefeBearer(app, req);
    const s = scopes(claims);
    const eigene = (claims.mitglied_ids || []).includes(req.params.id);
    const scope = schreiben ? 'mitglieder:schreiben' : 'mitglieder:person';
    if (!(s.has(scope) || (s.has('mitglieder:selbst') && eigene))) throw forbidden('Dafür fehlt die Berechtigung', 'scope_fehlt');
    const vereinId = verein(claims, req.query);
    const m = (await pool.query(
      // nur im Heimatverein: das Foto gehört der Person (FR-75)
      `select 1 from mitglieder m join personen p on p.id = m.person_id and p.heimatverein_id = m.verein_id
        where m.id = $1 and m.verein_id = $2 and m.geloescht_am is null and m.anonymisiert_am is null`, [req.params.id, vereinId])).rows[0];
    if (!m) throw notFound();
    return { claims, vereinId };
  };

  app.put('/mitglieder/:id/passfoto', { bodyLimit: FOTO_MAX + 64 * 1024, schema: { params: idParam } }, async (req, reply) => {
    const { claims, vereinId } = await fotoZugriff(req, true);
    let bild; let name = 'passfoto';
    if (req.isMultipart()) {
      const teil = await req.file();
      if (!teil) throw badRequest('Datei fehlt (Formularfeld „datei“)', 'datei_fehlt');
      bild = await teil.toBuffer();
      if (teil.file.truncated) throw badRequest('Das Foto ist größer als 5 MB', 'datei_zu_gross');
      name = teil.filename || name;
    } else if (Buffer.isBuffer(req.body)) bild = req.body;
    else throw badRequest('Bild als multipart/form-data (Feld „datei“) oder direkt als image/jpeg|png|webp senden', 'datei_fehlt');
    const typ = bildTyp(bild);
    if (!typ) throw badRequest('Nur JPEG, PNG oder WebP erlaubt', 'bildtyp_ungueltig');
    const basis = name.replace(/\.[^.]*$/, '').replace(/[^\w-]+/g, '_').slice(0, 60) || 'passfoto';
    const dateiname = `${basis}.${typ[1]}`;
    await tx(pool, async (db) => {
      const alt = (await db.query(`select id from dokumente where person_id = (select person_id from mitglieder where id = $1) and art = 'passfoto' and geloescht_am is null`, [req.params.id])).rows[0];
      if (alt) {
        await db.query('update dokumente set dateiname = $2, mime_typ = $3, groesse = $4, inhalt = $5, geaendert_am = now(), geaendert_von = $6 where id = $1',
          [alt.id, dateiname, typ[0], bild.length, bild, claims.sub]);
      } else {
        await db.query(
          `insert into dokumente (verein_id, mitglied_id, art, dateiname, mime_typ, groesse, inhalt, geaendert_von) values ($1,$2,'passfoto',$3,$4,$5,$6,$7)`,
          [vereinId, req.params.id, dateiname, typ[0], bild.length, bild, claims.sub]);
      }
    });
    return reply.code(200).send({ ok: true, mime_typ: typ[0], groesse: bild.length });
  });

  app.get('/mitglieder/:id/passfoto', { schema: { params: idParam } }, async (req, reply) => {
    await fotoZugriff(req, false);
    const d = (await pool.query(`select mime_typ, inhalt from dokumente where person_id = (select person_id from mitglieder where id = $1) and art = 'passfoto' and geloescht_am is null`, [req.params.id])).rows[0];
    if (!d) throw notFound('Kein Passfoto hinterlegt');
    return reply.header('Content-Type', d.mime_typ).header('Cache-Control', 'private, no-store').send(d.inhalt);
  });

  app.delete('/mitglieder/:id/passfoto', { schema: { params: idParam } }, async (req, reply) => {
    const { claims } = await fotoZugriff(req, true);
    await pool.query(
      `update dokumente set inhalt = null, groesse = 0, geloescht_am = now(), geaendert_am = now(), geaendert_von = $2
        where person_id = (select person_id from mitglieder where id = $1) and art = 'passfoto' and (geloescht_am is null or inhalt is not null)`, [req.params.id, claims.sub]);
    return reply.code(204).send();
  });
}
