import * as dienst from './dienst.js';

const uuid = { type: 'string', format: 'uuid' };
const objekt = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const BASIS = '/vereine/:verein_id/zugehoerigkeiten';

export default function routen(v2) {
  v2({ method: 'GET', url: '/ich', handler: (ctx, db) => dienst.ichLesen(ctx, db) });
  v2({
    method: 'POST', url: BASIS, status: 201, schema: { params: objekt({ verein_id: uuid }, ['verein_id']) },
    handler: (ctx, db, { params }) => dienst.zugehoerigkeitAnfragen(ctx, db, { verein_id: params.verein_id }),
  });
  v2({
    method: 'GET', url: BASIS,
    schema: {
      params: objekt({ verein_id: uuid }, ['verein_id']),
      querystring: objekt({ status: { type: 'string', enum: ['angefragt', 'freigegeben', 'abgelehnt', 'gesperrt'] } }),
    },
    handler: (ctx, db, { params, query }) => dienst.zugehoerigkeitenLesen(ctx, db, { verein_id: params.verein_id, status: query.status }),
  });
  v2({
    method: 'PATCH', url: `${BASIS}/:id`, ifMatch: true,
    schema: {
      params: objekt({ verein_id: uuid, id: uuid }, ['verein_id', 'id']),
      body: objekt({ entscheidung: { type: 'string', enum: ['freigeben', 'ablehnen', 'entziehen'] }, grund: { type: 'string', maxLength: 500 } }, ['entscheidung']),
    },
    handler: (ctx, db, { params, body, version }) => dienst.zugehoerigkeitEntscheiden(ctx, db, { ...params, ...body, version }),
  });
}
