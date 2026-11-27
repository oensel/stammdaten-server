import * as dienst from './dienst.js';

const uuid = { type: 'string', format: 'uuid' };
const datum = { type: 'string', format: 'date' };
const text = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
const objekt = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const PERSON = {
  vorname: text, nachname: text, geburtsdatum: datum, geschlecht: { type: 'string', enum: ['m', 'w', 'd'] }, nationalitaet: text,
  strasse: text, plz: text, ort: text, land: { type: 'string', pattern: '^[A-Z]{2}$' }, email: { type: 'string', format: 'email', maxLength: 200 }, telefon: text,
};

const leer = (s) => ({ ...s, type: ['string', 'null'] });
const KONTAKT = { strasse: leer(text), plz: leer(text), ort: leer(text), land: PERSON.land, email: leer(PERSON.email), telefon: leer(text) };
const mitId = objekt({ id: uuid }, ['id']);

export default function routen(v2) {
  v2({
    method: 'POST', url: '/vereine/:id/mitglieder', status: 201,
    schema: {
      params: objekt({ id: uuid }, ['id']),
      body: objekt({ person: objekt(PERSON, ['vorname', 'nachname', 'geburtsdatum']), eintritt: datum, judopass_id: { ...text, maxLength: 60 } }, ['person']),
    },
    handler: (ctx, db, { params, body }) => dienst.personAnlegen(ctx, db, { verein_id: params.id, ...body }),
  });
  v2({ method: 'GET', url: '/personen/:id', schema: { params: mitId }, handler: (ctx, db, { params }) => dienst.personLesen(ctx, db, params) });
  v2({
    method: 'PATCH', url: '/personen/:id/kontakt', ifMatch: true, schema: { params: mitId, body: { ...objekt(KONTAKT), minProperties: 1 } },
    handler: (ctx, db, { params, body, version }) => dienst.kontaktAendern(ctx, db, { id: params.id, version, aenderung: body }),
  });
  v2({ method: 'GET', url: '/ich/personen', handler: (ctx, db) => dienst.meinePersonen(ctx, db) });
  v2({ method: 'GET', url: '/personen/:id/zugriffe', schema: { params: mitId }, handler: (ctx, db, { params }) => dienst.zugriffeLesen(ctx, db, params) });
  v2({
    method: 'POST', url: '/personen/:id/zugriffe', status: 201,
    schema: {
      params: mitId,
      body: objekt({ benutzer_id: uuid, art: { type: 'string', enum: ['erziehungsberechtigt', 'bevollmaechtigt', 'vormund'] }, nachweis_id: uuid, umfang: { type: 'string', enum: ['lesen', 'aendern'] } }, ['benutzer_id', 'art', 'umfang']),
    },
    handler: (ctx, db, { params, body }) => dienst.zugriffErteilen(ctx, db, { id: params.id, ...body }),
  });
  v2({
    method: 'DELETE', url: '/personen/:id/zugriffe/:zugriff_id', schema: { params: objekt({ id: uuid, zugriff_id: uuid }, ['id', 'zugriff_id']) },
    handler: (ctx, db, { params }) => dienst.zugriffEntziehen(ctx, db, params),
  });
  v2({ method: 'GET', url: '/personen/:id/dokumente', schema: { params: mitId }, handler: (ctx, db, { params }) => dienst.dokumenteLesen(ctx, db, params) });
  v2({
    method: 'GET', url: '/personen/:id/dokumente/:dokument_id', schema: { params: objekt({ id: uuid, dokument_id: uuid }, ['id', 'dokument_id']) },
    handler: (ctx, db, { params }) => dienst.dokumentLesen(ctx, db, params),
  });
  // Datei roh im Body; kein Dateiname in der URL (NFR-1)
  v2({
    method: 'POST', url: '/personen/:id/dokumente', status: 201, bodyLimit: 10 * 1024 * 1024,
    schema: { params: mitId, querystring: objekt({ art: { type: 'string', enum: ['passfoto', 'scan', 'bescheinigung', 'vormundschaftsnachweis'] } }, ['art']) },
    handler: (ctx, db, { params, query: { art }, body }) => dienst.dokumentAblegen(ctx, db, { id: params.id, art, inhalt: body }),
  });
  v2({
    method: 'POST', url: '/personen/:id/dokumente/:dokument_id/bestaetigen', schema: { params: objekt({ id: uuid, dokument_id: uuid }, ['id', 'dokument_id']) },
    handler: (ctx, db, { params }) => dienst.nachweisBestaetigen(ctx, db, params),
  });
  v2({
    method: 'POST', url: '/personen/:id/konto', status: 201,
    schema: { params: mitId, body: objekt({ benutzername: { type: 'string', minLength: 3, maxLength: 60, pattern: '^[A-Za-z0-9._-]+$' } }, ['benutzername']) },
    handler: (ctx, db, { params, body, konten }) => dienst.kontoAnlegen(ctx, db, { id: params.id, ...body, konten }),
  });
  v2({ method: 'POST', url: '/ich/konto-bestaetigung', status: 202, handler: (ctx, db, { konten }) => dienst.bestaetigungAnfordern(ctx, db, { konten }) });
  v2({ method: 'GET', url: '/personen/:id/zugriffsabfrage', schema: { params: mitId }, handler: (ctx, db, { params, konten }) => dienst.abfrageLesen(ctx, db, { ...params, konten }) });
  v2({
    method: 'POST', url: '/personen/:id/zugriffsabfrage',
    schema: {
      params: mitId,
      body: objekt({ entscheidungen: { type: 'array', maxItems: 100, items: objekt({ zugriff_id: uuid, behalten: { type: 'boolean' } }, ['zugriff_id', 'behalten']) } }, ['entscheidungen']),
    },
    handler: (ctx, db, { params, body, konten }) => dienst.abfrageBeantworten(ctx, db, { id: params.id, ...body, konten }),
  });

  const ANTRAEGE = '/vereine/:id/mitgliedschaftsantraege';
  const mitAntrag = objekt({ id: uuid, antrag_id: uuid }, ['id', 'antrag_id']);
  const pass = { ...text, maxLength: 60 };
  v2({
    method: 'POST', url: '/mitgliedschaftsantraege', status: 201,
    schema: { body: objekt({ verein_id: uuid, person_id: uuid, judopass_nr: pass, vorname: text, nachname: text, geburtsdatum: datum }, ['verein_id']) },
    handler: (ctx, db, { body, konten }) => dienst.antragStellen(ctx, db, { ...body, konten }),
  });
  v2({ method: 'GET', url: '/ich/mitgliedschaftsantraege', handler: (ctx, db) => dienst.meineAntraege(ctx, db) });
  v2({ method: 'DELETE', url: '/mitgliedschaftsantraege/:id', schema: { params: mitId }, handler: (ctx, db, { params }) => dienst.antragZurueckziehen(ctx, db, params) });
  v2({
    method: 'POST', url: ANTRAEGE, status: 201,
    schema: { params: mitId, body: objekt({ person: objekt(PERSON, ['vorname', 'nachname', 'geburtsdatum']), judopass_nr: pass }, ['person']) },
    handler: (ctx, db, { params, body, konten }) => dienst.antragErfassen(ctx, db, { verein_id: params.id, ...body, konten }),
  });
  v2({
    method: 'GET', url: ANTRAEGE,
    schema: { params: mitId, querystring: objekt({ status: { type: 'string', enum: ['offen', 'angenommen', 'abgelehnt', 'zurueckgezogen', 'verfallen'] } }) },
    handler: (ctx, db, { params, query }) => dienst.antraegeLesen(ctx, db, { verein_id: params.id, status: query.status }),
  });
  v2({ method: 'GET', url: `${ANTRAEGE}/:antrag_id`, schema: { params: mitAntrag }, handler: (ctx, db, { params }) => dienst.antragLesen(ctx, db, { verein_id: params.id, id: params.antrag_id }) });
  v2({
    method: 'PATCH', url: `${ANTRAEGE}/:antrag_id`, ifMatch: true,
    schema: {
      params: mitAntrag,
      body: objekt({ entscheidung: { type: 'string', enum: ['annehmen', 'ablehnen'] }, reaktivieren: { type: 'boolean' }, eintritt: datum, grund: { type: 'string', maxLength: 500 } }, ['entscheidung']),
    },
    handler: (ctx, db, { params, body, version, konten }) => dienst.antragEntscheiden(ctx, db, { verein_id: params.id, id: params.antrag_id, version, ...body, konten }),
  });

  v2({
    method: 'PATCH', url: '/vereine/:id/mitglieder/:mitglied_id/austritt', ifMatch: true,
    schema: {
      params: objekt({ id: uuid, mitglied_id: uuid }, ['id', 'mitglied_id']),
      body: objekt({ austritt: { ...datum, type: ['string', 'null'] }, kuendigung_am: datum }, ['austritt']),
    },
    handler: (ctx, db, { params, body, version, konten }) => dienst.austrittSetzen(ctx, db, { verein_id: params.id, mitglied_id: params.mitglied_id, version, ...body, konten }),
  });

  const GRUPPEN = '/vereine/:id/gruppen';
  const GRUPPE = { name: { ...text, maxLength: 100 }, trainingszeiten: leer({ ...text, maxLength: 500 }), sortierung: { type: 'integer', minimum: 0, maximum: 10000 } };
  const mitGruppe = objekt({ id: uuid, gruppe_id: uuid }, ['id', 'gruppe_id']);
  const zuordnung = objekt({ id: uuid, gruppe_id: uuid, mitglied_id: uuid }, ['id', 'gruppe_id', 'mitglied_id']);
  const gruppe = (p) => ({ verein_id: p.id, id: p.gruppe_id });
  v2({ method: 'GET', url: GRUPPEN, schema: { params: mitId }, handler: (ctx, db, { params }) => dienst.gruppenLesen(ctx, db, { verein_id: params.id }) });
  v2({
    method: 'POST', url: GRUPPEN, status: 201, schema: { params: mitId, body: objekt(GRUPPE, ['name']) },
    handler: (ctx, db, { params, body }) => dienst.gruppeAnlegen(ctx, db, { verein_id: params.id, ...body }),
  });
  v2({
    method: 'PATCH', url: `${GRUPPEN}/:gruppe_id`, ifMatch: true, schema: { params: mitGruppe, body: { ...objekt(GRUPPE), minProperties: 1 } },
    handler: (ctx, db, { params, body, version }) => dienst.gruppeAendern(ctx, db, { ...gruppe(params), version, aenderung: body }),
  });
  v2({
    method: 'DELETE', url: `${GRUPPEN}/:gruppe_id`, ifMatch: true, schema: { params: mitGruppe },
    handler: (ctx, db, { params, version }) => dienst.gruppeLoeschen(ctx, db, { ...gruppe(params), version }),
  });
  v2({ method: 'GET', url: `${GRUPPEN}/:gruppe_id/mitglieder`, schema: { params: mitGruppe }, handler: (ctx, db, { params }) => dienst.gruppenMitgliederLesen(ctx, db, gruppe(params)) });
  for (const [method, zugeordnet] of [['PUT', true], ['DELETE', false]]) {
    v2({
      method, url: `${GRUPPEN}/:gruppe_id/mitglieder/:mitglied_id`, schema: { params: zuordnung },
      handler: (ctx, db, { params }) => dienst.mitgliedZuordnen(ctx, db, { ...gruppe(params), mitglied_id: params.mitglied_id, zugeordnet }),
    });
  }

  const TRANSFERS = '/vereine/:id/transfers';
  const mitTransfer = objekt({ id: uuid, transfer_id: uuid }, ['id', 'transfer_id']);
  v2({
    method: 'POST', url: TRANSFERS, status: 201,
    schema: { params: mitId, body: objekt({ person_id: uuid, nach_verein_id: uuid, wirksam_ab: datum, art: { type: 'string', enum: ['vereinswechsel', 'heimatwechsel'] } }, ['person_id', 'nach_verein_id', 'wirksam_ab']) },
    handler: (ctx, db, { params, body, konten }) => dienst.transferSenden(ctx, db, { verein_id: params.id, ...body, konten }),
  });
  v2({
    method: 'GET', url: TRANSFERS,
    schema: { params: mitId, querystring: objekt({ richtung: { type: 'string', enum: ['ausgehend', 'eingehend'] }, status: { type: 'string', enum: ['gesendet', 'angenommen', 'abgelehnt', 'zurueckgezogen', 'vollzogen', 'abgebrochen'] } }, ['richtung']) },
    handler: (ctx, db, { params, query }) => dienst.transfersLesen(ctx, db, { verein_id: params.id, richtung: query.richtung, status: query.status }),
  });
  v2({
    method: 'PATCH', url: `${TRANSFERS}/:transfer_id`, ifMatch: true,
    schema: { params: mitTransfer, body: objekt({ entscheidung: { type: 'string', enum: ['annehmen', 'ablehnen'] }, reaktivieren: { type: 'boolean' }, grund: { type: 'string', maxLength: 500 } }, ['entscheidung']) },
    handler: (ctx, db, { params, body, version, konten }) => dienst.transferEntscheiden(ctx, db, { verein_id: params.id, id: params.transfer_id, version, ...body, konten }),
  });
  v2({ method: 'DELETE', url: `${TRANSFERS}/:transfer_id`, schema: { params: mitTransfer }, handler: (ctx, db, { params }) => dienst.transferZurueckziehen(ctx, db, { verein_id: params.id, id: params.transfer_id }) });

  // Nur im Verbandskontext des Landesverbands (E70: kein Such-Endpunkt für Vereine)
  const such = { ...text, maxLength: 100 };
  v2({
    method: 'GET', url: '/personen/suche',
    schema: {
      querystring: objekt({
        nachname: such, vorname: such, geburtsdatum: datum, judopass_id: { ...text, maxLength: 60 }, verein_id: uuid,
        status: { type: 'string', enum: ['aktiv', 'ausgetreten'] }, zeitraum_von: datum, zeitraum_bis: datum,
      }),
    },
    handler: (ctx, db, { query }) => dienst.personenSuchen(ctx, db, {
      nachname: query.nachname ?? null, vorname: query.vorname ?? null, geburtsdatum: query.geburtsdatum ?? null, judopass_id: query.judopass_id ?? null,
      verein_id: query.verein_id ?? null, status: query.status ?? null, zeitraum_von: query.zeitraum_von ?? null, zeitraum_bis: query.zeitraum_bis ?? null,
    }),
  });
  v2({
    method: 'GET', url: '/aufgaben', schema: { querystring: objekt({ status: { type: 'string', enum: ['offen', 'erledigt'] } }) },
    handler: (ctx, db, { query }) => dienst.aufgabenLesen(ctx, db, { status: query.status ?? null }),
  });
  v2({ method: 'POST', url: '/aufgaben/:id/erledigen', schema: { params: mitId }, handler: (ctx, db, { params }) => dienst.aufgabeErledigen(ctx, db, params) });
}
