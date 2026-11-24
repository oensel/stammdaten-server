import * as dienst from './dienst.js';

export default function routen(v2) {
  v2({ method: 'GET', url: '/rechtekatalog', handler: (ctx, db) => dienst.katalogLesen(ctx, db) });
}
