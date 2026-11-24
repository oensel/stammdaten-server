// Fehler als application/problem+json (RFC 9457)
export class HttpError extends Error {
  constructor(status, detail, code) {
    super(detail);
    this.status = status;
    this.code = code;
    this.extra = {};
  }
}
export const fehler = (status, detail, code, extra) => Object.assign(new HttpError(status, detail, code), { extra: extra || {} });
export const badRequest = (d, c = 'ungueltige_anfrage') => fehler(400, d, c);
export const unauthorized = (d = 'Bitte anmelden', c = 'nicht_angemeldet') => fehler(401, d, c);
export const forbidden = (d = 'Keine Berechtigung', c = 'verboten') => fehler(403, d, c);
export const notFound = (d = 'Nicht gefunden') => fehler(404, d, 'nicht_gefunden');
export const conflict = (d, c = 'konflikt', extra) => fehler(409, d, c, extra);
export const tooMany = (d, extra) => fehler(429, d, 'zu_viele_versuche', extra);

const TITEL = { 400: 'Ungültige Anfrage', 401: 'Nicht angemeldet', 403: 'Verboten', 404: 'Nicht gefunden', 409: 'Konflikt', 412: 'Vorbedingung nicht erfüllt', 422: 'Nicht verarbeitbar', 428: 'Vorbedingung fehlt', 429: 'Zu viele Versuche' };

export function errorHandler(err, req, reply) {
  let status = err.status || err.statusCode || 500;
  let code = err.code;
  let detail = err.message;
  // NUL-Zeichen und ungültige Bytefolgen weist PostgreSQL ab: das ist eine fehlerhafte Eingabe, kein Serverfehler
  if (err.code === '22021' || err.code === '22P05') { status = 400; code = 'ungueltige_anfrage'; detail = 'Die Eingabe enthält ungültige Zeichen'; }
  if (err.validation) { status = 400; code = 'ungueltige_anfrage'; }
  if (status >= 500) { req.log.error(err); detail = 'Interner Fehler'; code = 'interner_fehler'; }
  reply.status(status).type('application/problem+json').send({
    type: 'about:blank', title: TITEL[status] || 'Fehler', status, code, detail, ...(err.extra || {}),
  });
}
