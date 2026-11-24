// Back-Channel-Logout (docs/sso-entscheidung.md 3): Wird eine Anmeldesitzung (sid) beendet, bekommen alle Apps des Benutzers mit
// `anwendungen.backchannel_url` ein signiertes Logout-Token (Header typ `logout+jwt`, Claims iss, sub, aud = App, sid, iat, exp = +120 s, jti, events).
// Zustellung: POST JSON { "logout_token": "<jwt>" }; bis zu 3 Versuche (Wartezeiten cfg.backchannelWartenMs), danach wird aufgegeben.
import { randomUUID } from 'node:crypto';
import { signJwt } from './jwt.js';

const EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const schlafen = (ms) => new Promise((r) => setTimeout(r, ms));

export function registriereBackchannel(app) {
  const laufend = new Set();

  async function senden(a, benutzerId, sid) {
    const jetzt = Math.floor(Date.now() / 1000);
    const token = signJwt({
      iss: app.cfg.issuer, sub: benutzerId, aud: a.schluessel, sid, iat: jetzt, exp: jetzt + 120, jti: randomUUID(), events: { [EVENT]: {} },
    }, app.keys, 'logout+jwt');
    const waits = app.cfg.backchannelWartenMs;
    for (let i = 0; i < waits.length; i++) {
      if (waits[i]) await schlafen(waits[i]);
      try {
        const r = await fetch(a.backchannel_url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ logout_token: token }), signal: AbortSignal.timeout(5000),
        });
        if (r.ok) return true;
        app.log.warn({ app: a.schluessel, status: r.status, versuch: i + 1 }, 'Back-Channel-Logout abgelehnt');
      } catch (e) {
        app.log.warn({ app: a.schluessel, fehler: e.message, versuch: i + 1 }, 'Back-Channel-Logout nicht zugestellt');
      }
    }
    return false;
  }

  /** Apps benachrichtigen (im Hintergrund). sids = beendete Sitzungen; Rückgabe = Promise, das nach der Zustellung erfüllt ist. */
  app.decorate('sitzungBeendet', (benutzerId, sids) => {
    const p = (async () => {
      if (!sids.length) return;
      const apps = (await app.pool.query(
        `select a.schluessel, a.backchannel_url from anwendungen a
          where a.aktiv and a.backchannel_url is not null
            and exists (select 1 from anwendung_vereine av join benutzer_vereine bv on bv.verein_id = av.verein_id
                         where av.anwendung_id = a.id and bv.benutzer_id = $1 and bv.status = 'freigegeben' and bv.geloescht_am is null)`,
        [benutzerId])).rows;
      await Promise.all(apps.flatMap((a) => sids.map((sid) => senden(a, benutzerId, sid))));
    })().catch((e) => app.log.warn({ fehler: e.message }, 'Back-Channel-Logout fehlgeschlagen')).finally(() => laufend.delete(p));
    laufend.add(p);
    return p;
  });
  /** Wartet auf alle laufenden Zustellungen (Tests, geordnetes Beenden). */
  app.decorate('backchannelFertig', () => Promise.all([...laufend]));
}
