// Eigenes Konto: GET/PATCH/DELETE /ich
import { tx } from '../db.js';
import { badRequest, conflict, forbidden, unauthorized } from '../errors.js';
import { ladeBenutzerObjekt, pruefeBearer, widerrufeAlle } from '../auth.js';
import { erzeugeEinmalToken, link } from '../einmal.js';
import { PIN_RE, PW_MAX, hashSecret, pruefeNeuesPasswort, verifySecret } from '../passwords.js';

export default async function ichRoutes(app) {
  const pool = app.pool;
  const lade = async (id) =>
    (await pool.query(
      `select id, benutzername, email, email_bestaetigt_am, vorname, nachname, passwort_hash, pin_hash is not null as pin_gesetzt,
              muss_passwort_aendern, ist_super_admin, totp_aktiv_am is not null as totp_aktiv, heimatverein_id, letzte_anmeldung_am
         from benutzer where id = $1`, [id])).rows[0];

  async function pruefePasswort(u, passwort) {
    if (!passwort || !(await verifySecret(u.passwort_hash, passwort))) throw unauthorized('Aktuelles Passwort falsch', 'passwort_falsch');
  }

  app.get('/ich', async (req) => {
    const claims = await pruefeBearer(app, req, { erlaubeMussPasswort: true });
    const u = await lade(claims.sub);
    const anw = (await pool.query('select scopes from anwendungen where schluessel = $1', [claims.azp || claims.aud])).rows[0] || { scopes: [] };
    const { vereine } = await ladeBenutzerObjekt(pool, u.id, anw, claims.verein_id);
    return {
      id: u.id, benutzername: u.benutzername, email: u.email, email_bestaetigt: !!u.email_bestaetigt_am, vorname: u.vorname, nachname: u.nachname,
      super_admin: u.ist_super_admin, pin_gesetzt: u.pin_gesetzt, totp_aktiv: u.totp_aktiv, muss_passwort_aendern: u.muss_passwort_aendern,
      heimatverein_id: u.heimatverein_id, vereine,
      aktiv: {
        aud: claims.azp || claims.aud, verein_id: claims.verein_id, rolle: claims.rolle, rechte: claims.rechte, scope: claims.scope ? claims.scope.split(' ') : [],
        mitglied_id: claims.mitglied_id, mitglied_ids: claims.mitglied_ids, geraet_id: claims.geraet_id || null,
      },
    };
  });

  app.patch('/ich', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          vorname: { type: ['string', 'null'], maxLength: 100 },
          nachname: { type: ['string', 'null'], maxLength: 100 },
          email: { type: ['string', 'null'], maxLength: 200, format: 'email' },
          passwort_alt: { type: 'string', maxLength: PW_MAX },
          passwort_neu: { type: 'string', maxLength: PW_MAX },
          pin: { type: ['string', 'null'], maxLength: 12 },
          heimatverein_id: { type: ['string', 'null'], format: 'uuid' },
        },
      },
    },
  }, async (req) => {
    const claims = await pruefeBearer(app, req, { erlaubeMussPasswort: true });
    const b = req.body;
    const u = await lade(claims.sub);
    if (claims.muss_passwort_aendern && !b.passwort_neu) throw forbidden('Bitte zuerst ein eigenes Passwort festlegen', 'passwort_aendern');
    const sets = []; const werte = []; const setze = (spalte, w) => { werte.push(w); sets.push(`${spalte} = $${werte.length}`); };

    let neueMail = null;
    for (const f of ['vorname', 'nachname']) if (f in b) setze(f, b[f]?.trim() || null);
    if ('email' in b) {
      const mail = b.email ? b.email.trim() : null;
      if (mail?.toLowerCase() !== (u.email || '').toLowerCase()) { setze('email', mail); sets.push('email_bestaetigt_am = null'); neueMail = mail; }
    }
    let passwortGeaendert = false;
    if ('passwort_neu' in b) {
      await pruefePasswort(u, b.passwort_alt);
      pruefeNeuesPasswort(b.passwort_neu, u.benutzername);
      if (b.passwort_neu === b.passwort_alt) throw badRequest('Das neue Passwort muss sich vom alten unterscheiden', 'passwort_unveraendert');
      setze('passwort_hash', await hashSecret(b.passwort_neu));
      sets.push('muss_passwort_aendern = false', 'passwort_geaendert_am = now()');
      passwortGeaendert = true;
    }
    if ('heimatverein_id' in b) {
      if (b.heimatverein_id) {
        const ok = (await pool.query(
          `select 1 from benutzer_vereine where benutzer_id = $1 and verein_id = $2 and status = 'freigegeben' and geloescht_am is null`,
          [u.id, b.heimatverein_id])).rows[0];
        if (!ok) throw forbidden('Kein freigegebener Verein', 'kein_zugang_zum_verein');
      }
      setze('heimatverein_id', b.heimatverein_id);
    }
    if ('pin' in b) {
      if (b.pin !== null) {
        if (u.muss_passwort_aendern && !passwortGeaendert) throw forbidden('Bitte zuerst ein eigenes Passwort festlegen', 'passwort_aendern');
        await pruefePasswort(u, b.passwort_alt);
        if (!PIN_RE.test(b.pin)) throw badRequest('Die PIN muss aus 4 bis 6 Ziffern bestehen', 'pin_ungueltig');
        setze('pin_hash', await hashSecret(b.pin));
        sets.push('pin_fehlversuche = 0');
      } else {
        setze('pin_hash', null);
      }
    }
    if (!sets.length) return { ok: true };
    try {
      await tx(pool, async (db) => {
        werte.push(u.id);
        await db.query(`update benutzer set ${sets.join(', ')}, geaendert_am = now(), geaendert_von = $${werte.length} where id = $${werte.length}`, werte);
        // andere Anmeldungen (andere Geräte) enden bei Passwortwechsel; die aktuelle (sid) bleibt
        if (passwortGeaendert) await widerrufeAlle(db, u.id, claims.sid);
      });
    } catch (e) {
      if (e.code === '23505') throw conflict('Diese E-Mail-Adresse wird schon verwendet', 'email_vergeben');
      throw e;
    }
    if (neueMail) {
      const t = await erzeugeEinmalToken(pool, { benutzerId: u.id, zweck: 'email_bestaetigung', stunden: 48 });
      await app.mailer.send({ to: neueMail, subject: 'E-Mail-Adresse bestätigen', text: `Bitte bestätige deine E-Mail-Adresse:\n\n${link(app.cfg, 'email-bestaetigen', t)}\n` });
    }
    return { ok: true, ...(passwortGeaendert && claims.muss_passwort_aendern ? { hinweis: 'Zugangstoken erneuern (Refresh), damit die Rechte gelten' } : {}) };
  });

  // Konto löschen (Soft Delete; datenschutz_bereinigen() anonymisiert nach der Frist)
  app.delete('/ich', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['passwort'], properties: { passwort: { type: 'string', maxLength: PW_MAX } } } },
  }, async (req, reply) => {
    const claims = await pruefeBearer(app, req, { erlaubeMussPasswort: true });
    const u = await lade(claims.sub);
    await pruefePasswort(u, req.body.passwort);
    await tx(pool, async (db) => {
      await db.query(
        `update benutzer set geloescht_am = now(), aktiv = false, passwort_hash = null, pin_hash = null, geaendert_am = now() where id = $1`, [u.id]);
      await db.query(`update benutzer_vereine set geloescht_am = now() where benutzer_id = $1 and geloescht_am is null`, [u.id]);
      await widerrufeAlle(db, u.id);
    });
    return reply.code(204).send();
  });
}
