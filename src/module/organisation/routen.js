import * as dienst from './dienst.js';

const uuid = { type: 'string', format: 'uuid' };
const uuidOderNull = { type: ['string', 'null'], format: 'uuid' };
const text = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
const textOderNull = { type: ['string', 'null'], minLength: 1, maxLength: 200 };
const objekt = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const mitId = objekt({ id: uuid }, ['id']);

const verband = { name: text, kurzname: textOderNull, uebergeordnet_id: uuidOderNull };
const verein = { name: text, kurzname: textOderNull, vereinsnummer: textOderNull, ort: textOderNull, verband_id: uuidOderNull };

export default function routen(v2) {
  v2({ method: 'GET', url: '/verbandsbaum', handler: (ctx, db) => dienst.baumLesen(ctx, db) });
  v2({
    method: 'POST', url: '/verbaende', status: 201,
    schema: { body: objekt({ ...verband, typ: { type: 'string', enum: ['dachverband', 'landesverband', 'bezirk', 'kreis'] } }, ['name', 'typ']) },
    handler: (ctx, db, { body }) => dienst.verbandAnlegen(ctx, db, body),
  });
  v2({
    method: 'PATCH', url: '/verbaende/:id', ifMatch: true, schema: { params: mitId, body: { ...objekt(verband), minProperties: 1 } },
    handler: (ctx, db, { params, body, version }) => dienst.verbandAendern(ctx, db, { id: params.id, version, aenderung: body }),
  });
  v2({
    method: 'POST', url: '/vereine', status: 201, schema: { body: objekt(verein, ['name']) },
    handler: (ctx, db, { body }) => dienst.vereinAnlegen(ctx, db, body),
  });
  v2({
    method: 'PATCH', url: '/vereine/:id', ifMatch: true,
    schema: { params: mitId, body: { ...objekt({ ...verein, aufgeloest_am: { type: ['string', 'null'], format: 'date' } }), minProperties: 1 } },
    handler: (ctx, db, { params, body, version }) => dienst.vereinAendern(ctx, db, { id: params.id, version, aenderung: body }),
  });
}
