import * as dienst from './dienst.js';

const uuid = { type: 'string', format: 'uuid' };
const text = { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' };
const objekt = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const verband = objekt({ id: uuid }, ['id']);
const amt = objekt({ id: uuid, rolle_id: uuid }, ['id', 'rolle_id']);
const stv = objekt({ id: uuid, rolle_id: uuid, stellvertreter_id: uuid }, ['id', 'rolle_id', 'stellvertreter_id']);

const verein = objekt({ id: uuid }, ['id']);
const vereinsrolle = objekt({ id: uuid, rolle_id: uuid }, ['id', 'rolle_id']);
const vergabe = objekt({ id: uuid, rolle_id: uuid, benutzer_id: uuid }, ['id', 'rolle_id', 'benutzer_id']);
const name = { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' };
const berechtigungen = { type: 'array', maxItems: 200, uniqueItems: true, items: { type: 'string', pattern: '^[a-z_]+:[A-Z]+$' } };

export default function routen(v2) {
  v2({ method: 'GET', url: '/rechtekatalog', handler: (ctx, db) => dienst.katalogLesen(ctx, db) });
  v2({ method: 'GET', url: '/verbaende/:id/rollen', schema: { params: verband }, handler: (ctx, db, { params }) => dienst.verbandsrollenLesen(ctx, db, { verband_id: params.id }) });
  v2({
    method: 'POST', url: '/verbaende/:id/rollen', status: 201,
    schema: { params: verband, body: objekt({ benutzer_id: uuid, rolle: { type: 'string', pattern: '^[a-z_]{1,60}$' }, grund: text }, ['benutzer_id', 'rolle']) },
    handler: (ctx, db, { params, body }) => dienst.verbandsrolleVergeben(ctx, db, { verband_id: params.id, ...body }),
  });
  v2({
    method: 'DELETE', url: '/verbaende/:id/rollen/:rolle_id', schema: { params: amt, querystring: objekt({ grund: text }) },
    handler: (ctx, db, { params, query }) => dienst.verbandsrolleEntziehen(ctx, db, { verband_id: params.id, id: params.rolle_id, grund: query.grund }),
  });
  v2({
    method: 'POST', url: '/verbaende/:id/rollen/:rolle_id/stellvertreter', status: 201,
    schema: { params: amt, body: objekt({ benutzer_id: uuid, grund: text }, ['benutzer_id', 'grund']) },
    handler: (ctx, db, { params, body }) => dienst.stellvertreterErnennen(ctx, db, { verband_id: params.id, id: params.rolle_id, ...body }),
  });
  v2({
    method: 'DELETE', url: '/verbaende/:id/rollen/:rolle_id/stellvertreter/:stellvertreter_id',
    schema: { params: stv, querystring: objekt({ grund: text }, ['grund']) },
    handler: (ctx, db, { params, query }) => dienst.stellvertreterEntziehen(ctx, db, { verband_id: params.id, id: params.rolle_id, stellvertreter_id: params.stellvertreter_id, grund: query.grund }),
  });
  v2({ method: 'GET', url: '/vereine/:id/rollen', schema: { params: verein }, handler: (ctx, db, { params }) => dienst.vereinsrollenLesen(ctx, db, { verein_id: params.id }) });
  v2({
    method: 'POST', url: '/vereine/:id/rollen', status: 201, schema: { params: verein, body: objekt({ name, berechtigungen }, ['name', 'berechtigungen']) },
    handler: (ctx, db, { params, body }) => dienst.vereinsrolleAnlegen(ctx, db, { verein_id: params.id, ...body }),
  });
  v2({
    method: 'PATCH', url: '/vereine/:id/rollen/:rolle_id', schema: { params: vereinsrolle, body: { ...objekt({ name, berechtigungen }), minProperties: 1 } },
    handler: (ctx, db, { params, body }) => dienst.vereinsrolleAendern(ctx, db, { verein_id: params.id, id: params.rolle_id, ...body }),
  });
  v2({
    method: 'DELETE', url: '/vereine/:id/rollen/:rolle_id', schema: { params: vereinsrolle },
    handler: (ctx, db, { params }) => dienst.vereinsrolleLoeschen(ctx, db, { verein_id: params.id, id: params.rolle_id }),
  });
  v2({
    method: 'POST', url: '/vereine/:id/rollen/:rolle_id/benutzer', status: 201, schema: { params: vereinsrolle, body: objekt({ benutzer_id: uuid }, ['benutzer_id']) },
    handler: (ctx, db, { params, body }) => dienst.vereinsrolleZuweisen(ctx, db, { verein_id: params.id, id: params.rolle_id, benutzer_id: body.benutzer_id }),
  });
  v2({
    method: 'DELETE', url: '/vereine/:id/rollen/:rolle_id/benutzer/:benutzer_id', schema: { params: vergabe },
    handler: (ctx, db, { params }) => dienst.vereinsrolleEntziehen(ctx, db, { verein_id: params.id, id: params.rolle_id, benutzer_id: params.benutzer_id }),
  });
}
