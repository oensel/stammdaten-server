import * as dienst from './dienst.js';

const uuid = { type: 'string', format: 'uuid' };
const datum = { type: 'string', format: 'date' };
const text = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
const objekt = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const PERSON = {
  vorname: text, nachname: text, geburtsdatum: datum, geschlecht: { type: 'string', enum: ['m', 'w', 'd'] }, nationalitaet: text,
  strasse: text, plz: text, ort: text, land: { type: 'string', pattern: '^[A-Z]{2}$' }, email: { type: 'string', format: 'email', maxLength: 200 }, telefon: text,
};

export default function routen(v2) {
  v2({
    method: 'POST', url: '/vereine/:id/mitglieder', status: 201,
    schema: {
      params: objekt({ id: uuid }, ['id']),
      body: objekt({ person: objekt(PERSON, ['vorname', 'nachname', 'geburtsdatum']), eintritt: datum, judopass_id: { ...text, maxLength: 60 } }, ['person']),
    },
    handler: (ctx, db, { params, body }) => dienst.personAnlegen(ctx, db, { verein_id: params.id, ...body }),
  });
}
