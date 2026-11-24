import * as dienst from './dienst.js';

const uuid = { type: 'string', format: 'uuid' };
const datum = { type: 'string', format: 'date' };
const text = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
const objekt = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const PERSON = {
  vorname: text, nachname: text, geburtsdatum: datum, geschlecht: { type: 'string', enum: ['m', 'w', 'd'] }, nationalitaet: text,
  strasse: text, plz: text, ort: text, land: { type: 'string', pattern: '^[A-Z]{2}$' }, email: { type: 'string', format: 'email', maxLength: 200 }, telefon: text,
};

const leer = (s) => ({ ...s, type: ['string', 'null'] });
const KONTAKT = { strasse: leer(text), plz: leer(text), ort: leer(text), land: PERSON.land, email: leer(PERSON.email), telefon: leer(text) };
const mitId = objekt({ id: uuid }, ['id']);

export default function routen(v2) {
  v2({
    method: 'POST', url: '/vereine/:id/mitglieder', status: 201,
    schema: {
      params: objekt({ id: uuid }, ['id']),
      body: objekt({ person: objekt(PERSON, ['vorname', 'nachname', 'geburtsdatum']), eintritt: datum, judopass_id: { ...text, maxLength: 60 } }, ['person']),
    },
    handler: (ctx, db, { params, body }) => dienst.personAnlegen(ctx, db, { verein_id: params.id, ...body }),
  });
  v2({ method: 'GET', url: '/personen/:id', schema: { params: mitId }, handler: (ctx, db, { params }) => dienst.personLesen(ctx, db, params) });
  v2({
    method: 'PATCH', url: '/personen/:id/kontakt', ifMatch: true, schema: { params: mitId, body: { ...objekt(KONTAKT), minProperties: 1 } },
    handler: (ctx, db, { params, body, version }) => dienst.kontaktAendern(ctx, db, { id: params.id, version, aenderung: body }),
  });
  v2({ method: 'GET', url: '/ich/personen', handler: (ctx, db) => dienst.meinePersonen(ctx, db) });
  v2({ method: 'GET', url: '/personen/:id/zugriffe', schema: { params: mitId }, handler: (ctx, db, { params }) => dienst.zugriffeLesen(ctx, db, params) });
  v2({
    method: 'POST', url: '/personen/:id/zugriffe', status: 201,
    schema: {
      params: mitId,
      body: objekt({ benutzer_id: uuid, art: { type: 'string', enum: ['erziehungsberechtigt', 'bevollmaechtigt'] }, umfang: { type: 'string', enum: ['lesen', 'aendern'] } }, ['benutzer_id', 'art', 'umfang']),
    },
    handler: (ctx, db, { params, body }) => dienst.zugriffErteilen(ctx, db, { id: params.id, ...body }),
  });
  v2({
    method: 'DELETE', url: '/personen/:id/zugriffe/:zugriff_id', schema: { params: objekt({ id: uuid, zugriff_id: uuid }, ['id', 'zugriff_id']) },
    handler: (ctx, db, { params }) => dienst.zugriffEntziehen(ctx, db, params),
  });
  v2({ method: 'GET', url: '/personen/:id/dokumente', schema: { params: mitId }, handler: (ctx, db, { params }) => dienst.dokumenteLesen(ctx, db, params) });
  v2({
    method: 'GET', url: '/personen/:id/dokumente/:dokument_id', schema: { params: objekt({ id: uuid, dokument_id: uuid }, ['id', 'dokument_id']) },
    handler: (ctx, db, { params }) => dienst.dokumentLesen(ctx, db, params),
  });
  // Datei roh im Body; kein Dateiname in der URL (NFR-1)
  v2({
    method: 'POST', url: '/personen/:id/dokumente', status: 201, bodyLimit: 10 * 1024 * 1024,
    schema: { params: mitId, querystring: objekt({ art: { type: 'string', enum: ['passfoto', 'scan', 'bescheinigung', 'vormundschaftsnachweis'] } }, ['art']) },
    handler: (ctx, db, { params, query: { art }, body }) => dienst.dokumentAblegen(ctx, db, { id: params.id, art, inhalt: body }),
  });
}
