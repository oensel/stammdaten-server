import * as dienst from './dienst.js';

const uuid = { type: 'string', format: 'uuid' };
const objekt = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const BASIS = '/vereine/:verein_id/zugehoerigkeiten';
const QR = '/vereine/:verein_id/qr-codes';
const mitVerein = objekt({ verein_id: uuid }, ['verein_id']);
const token = { type: 'string', minLength: 20, maxLength: 200 };
const name = { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' };

export default function routen(v2) {
  v2({ method: 'GET', url: '/ich', handler: (ctx, db) => dienst.ichLesen(ctx, db) });
  v2({
    method: 'POST', url: '/zugehoerigkeiten', status: 201, schema: { body: objekt({ token }, ['token']) },
    handler: (ctx, db, { body }) => dienst.zugehoerigkeitAnfragen(ctx, db, body),
  });
  v2({
    method: 'POST', url: '/auth/registrieren', status: 201, oeffentlich: true,
    schema: {
      body: objekt({
        token, benutzername: { type: 'string', minLength: 3, maxLength: 60, pattern: '^[A-Za-z0-9._-]+$' },
        vorname: name, nachname: name, passwort: { type: 'string', maxLength: 200 },
      }, ['token', 'benutzername', 'vorname', 'nachname', 'passwort']),
    },
    handler: (ctx, db, { body }) => dienst.registrieren(ctx, db, body),
  });
  v2({
    method: 'POST', url: QR, status: 201,
    schema: { params: mitVerein, body: objekt({ gueltig_tage: { type: 'integer', minimum: 1, maximum: 365 } }) },
    handler: (ctx, db, { params, body }) => dienst.qrCodeAnlegen(ctx, db, { ...params, ...body }),
  });
  v2({ method: 'GET', url: QR, schema: { params: mitVerein }, handler: (ctx, db, { params }) => dienst.qrCodesLesen(ctx, db, params) });
  v2({
    method: 'POST', url: `${QR}/:id/widerrufen`, schema: { params: objekt({ verein_id: uuid, id: uuid }, ['verein_id', 'id']) },
    handler: (ctx, db, { params }) => dienst.qrCodeWiderrufen(ctx, db, params),
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
