import * as dienst from './dienst.js';

const uuid = { type: 'string', format: 'uuid' };
const text = { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' };
const objekt = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const verband = objekt({ id: uuid }, ['id']);
const amt = objekt({ id: uuid, rolle_id: uuid }, ['id', 'rolle_id']);
const stv = objekt({ id: uuid, rolle_id: uuid, stellvertreter_id: uuid }, ['id', 'rolle_id', 'stellvertreter_id']);

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
}
