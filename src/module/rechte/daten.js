export const direktrechteBeenden = (db, { benutzerId, vereinId, von, jetzt }) => db.query(
  'update benutzer_rechte set geloescht_am = $3, geaendert_von = $4 where benutzer_id = $1 and verein_id = $2 and geloescht_am is null',
  [benutzerId, vereinId, jetzt, von]);

const MIT_RECHTEN = `select r.schluessel, coalesce(array_agg(b.recht || ':' || b.operation) filter (where b.recht is not null), '{}') as rechte,
          coalesce(jsonb_object_agg(b.recht || ':' || b.operation, to_jsonb(f)) filter (where f.id is not null), '{}') as filter
     from rollen r left join rollen_berechtigungen b on b.rolle_id = r.id left join datenfilter f on f.id = b.datenfilter_id`;
export const rollenMitRechten = async (db, schluessel) => (await db.query(
  `${MIT_RECHTEN} where r.verein_id is null and r.schluessel = any($1) group by r.id order by r.schluessel`, [schluessel])).rows;

/** Vereinseigene Rollen, die der Benutzer im Verein hat. */
export const eigeneRollenMitRechten = async (db, { benutzerId, vereinId }) => (await db.query(
  `${MIT_RECHTEN} where r.verein_id = $2 and r.id in (select rolle_id from benutzer_vereinsrollen where benutzer_id = $1 and verein_id = $2 and beendet_am is null)
    group by r.id order by r.schluessel`, [benutzerId, vereinId])).rows;

/** 1 = Dachverband … 4 = Kreis */
export const ebene = async (db, verbandId) => (await db.query('select count(*)::int n from verband_pfade where nachfahr_id = $1', [verbandId])).rows[0].n;

export const vorfahren = async (db, ids) => Object.fromEntries((await db.query(
  'select nachfahr_id, array_agg(vorfahr_id) as v from verband_pfade where nachfahr_id = any($1::uuid[]) group by nachfahr_id', [ids])).rows.map((r) => [r.nachfahr_id, r.v]));

export const systemrollen = async (db) => (await db.query(
  `select r.id, r.schluessel, r.name, r.ebene, r.verband_typen,
          coalesce((select array_agg(b.recht || ':' || b.operation order by b.recht, b.operation) from rollen_berechtigungen b where b.rolle_id = r.id), '{}') as berechtigungen
     from rollen r where r.verein_id is null order by r.ebene, r.schluessel`)).rows;

export const rollentraeger = async (db, { verbandIds, rolle }) => (await db.query(
  'select distinct benutzer_id from benutzer_verbandsrollen where verband_id = any($1::uuid[]) and rolle = $2 and beendet_am is null', [verbandIds, rolle])).rows;

export const verbandsrollen = async (db, benutzerId) => (await db.query(
  'select id, rolle, verband_id, stellvertreter_von from benutzer_verbandsrollen where benutzer_id = $1 and beendet_am is null', [benutzerId])).rows;

export const rollenImVerband = async (db, verbandId) => (await db.query(
  `select id, benutzer_id, rolle, stellvertreter_von, erstellt_am, grund from benutzer_verbandsrollen
    where verband_id = $1 and beendet_am is null order by rolle, stellvertreter_von nulls first, erstellt_am`, [verbandId])).rows;

export const rolleSperren = async (db, { id, verbandId }) => (await db.query(
  'select * from benutzer_verbandsrollen where id = $1 and verband_id = $2 and beendet_am is null for update', [id, verbandId])).rows[0];

export const rolleEinfuegen = async (db, r) => (await db.query(
  `insert into benutzer_verbandsrollen (benutzer_id, verband_id, rolle, stellvertreter_von, erstellt_von, grund, erstellt_am)
   values ($1,$2,$3,$4,$5,$6,$7) returning id, benutzer_id, verband_id, rolle, stellvertreter_von, grund`,
  [r.benutzerId, r.verbandId, r.rolle, r.stellvertreterVon ?? null, r.von, r.grund ?? null, r.jetzt])).rows[0];

export const stellvertreterAktiv = async (db, amtId) => (await db.query(
  'select id, benutzer_id from benutzer_verbandsrollen where stellvertreter_von = $1 and beendet_am is null', [amtId])).rows;

export const rolleBeenden = async (db, { id, von, grund, jetzt }) => (await db.query(
  `update benutzer_verbandsrollen set beendet_am = $2, beendet_von = $3, grund = coalesce($4, grund) where id = $1
   returning id, benutzer_id, verband_id, rolle, stellvertreter_von`, [id, jetzt, von, grund ?? null])).rows[0];

// ---- vereinseigene Rollen (Story 2.7) ----
export const vereinsrollenLesen = async (db, vereinId) => (await db.query(
  `select r.id, r.schluessel, r.name,
          coalesce((select array_agg(b.recht || ':' || b.operation order by b.recht, b.operation) from rollen_berechtigungen b where b.rolle_id = r.id), '{}') as berechtigungen,
          (select count(*)::int from benutzer_vereinsrollen v where v.rolle_id = r.id and v.beendet_am is null) as vergeben
     from rollen r where r.verein_id = $1 and not r.ist_system order by r.name`, [vereinId])).rows;

export const vereinsrolleSperren = async (db, { id, vereinId }) => (await db.query(
  'select id, schluessel, name from rollen where id = $1 and verein_id = $2 and not ist_system for update', [id, vereinId])).rows[0];

export const vereinsrolleAnlegen = async (db, { vereinId, schluessel, name }) => (await db.query(
  `insert into rollen (schluessel, name, ebene, verein_id) values ($1, $2, 'verein', $3) returning id, schluessel, name`, [schluessel, name, vereinId])).rows[0];

export const vereinsrolleUmbenennen = (db, { id, name }) => db.query('update rollen set name = $2 where id = $1', [id, name]);

export const berechtigungenErsetzen = async (db, { rolleId, berechtigungen }) => {
  await db.query('delete from rollen_berechtigungen where rolle_id = $1', [rolleId]);
  for (const b of berechtigungen) {
    const [recht, operation] = b.split(':');
    await db.query('insert into rollen_berechtigungen (rolle_id, recht, operation) values ($1,$2,$3)', [rolleId, recht, operation]);
  }
};

export const vereinsrolleVergeben = async (db, { rolleId, vereinId }) => (await db.query(
  'select count(*)::int n from benutzer_vereinsrollen where rolle_id = $1 and verein_id = $2 and beendet_am is null', [rolleId, vereinId])).rows[0].n;

export const vereinsrolleLoeschen = async (db, id) => {
  await db.query('delete from benutzer_vereinsrollen where rolle_id = $1', [id]); // nur beendete Vergaben, der Verlauf liegt im Audit
  await db.query('delete from rollen where id = $1', [id]);
};

export const vereinsrolleZuweisen = async (db, { benutzerId, vereinId, rolleId, von, jetzt }) => (await db.query(
  `insert into benutzer_vereinsrollen (benutzer_id, verein_id, rolle_id, erstellt_von, erstellt_am) values ($1,$2,$3,$4,$5)
   returning id, benutzer_id, verein_id, rolle_id`, [benutzerId, vereinId, rolleId, von, jetzt])).rows[0];

export const vereinsrolleEntziehen = async (db, { benutzerId, vereinId, rolleId, von, jetzt }) => (await db.query(
  `update benutzer_vereinsrollen set beendet_am = $4, beendet_von = $5
    where benutzer_id = $1 and verein_id = $2 and rolle_id = $3 and beendet_am is null returning id, benutzer_id, verein_id, rolle_id`,
  [benutzerId, vereinId, rolleId, jetzt, von])).rows[0];

export const positivliste = async (db) => (await db.query('select schluessel from katalog_rechte where vereinsrolle_erlaubt')).rows.map((r) => r.schluessel);

// ---- Delegation (Story 2.8) ----
export const datenfilterLesen = async (db, schluessel) => (await db.query('select * from datenfilter where schluessel = $1', [schluessel])).rows[0];

const SPALTEN = 'id, empfaenger_id, geber_id, verein_id, verband_id, recht, operation, datenfilter_id, gueltig_von, gueltig_bis, delegiert_aus_quelle, delegiert_aus_schluessel, grund, verwaist_seit';

export const delegationEinfuegen = async (db, d) => (await db.query(
  `insert into delegationen (empfaenger_id, geber_id, verein_id, verband_id, recht, operation, datenfilter_id, gueltig_von, gueltig_bis, delegiert_aus_quelle, delegiert_aus_schluessel, grund, erstellt_am)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning ${SPALTEN}`,
  [d.empfaengerId, d.geberId, d.vereinId ?? null, d.verbandId ?? null, d.recht, d.operation, d.datenfilterId ?? null, d.von, d.bis, d.quelle?.art ?? null, d.quelle?.schluessel ?? null, d.grund ?? null, d.jetzt])).rows[0];

export const delegationSperren = async (db, id) => (await db.query(`select ${SPALTEN} from delegationen where id = $1 and beendet_am is null for update`, [id])).rows[0];

export const delegationenLesen = async (db, { vereinId, verbandId, nurVerwaist }) => (await db.query(
  `select ${SPALTEN} from delegationen where beendet_am is null and ($1::uuid is null or verein_id = $1) and ($2::uuid is null or verband_id = $2)
      and (not $3 or verwaist_seit is not null) order by erstellt_am`, [vereinId ?? null, verbandId ?? null, !!nurVerwaist])).rows;

/** Beendet Delegationen eines Bereichs (alle eines Gebers oder alle verwaisten) und liefert sie. */
export const delegationenBeenden = async (db, { id, vereinId, verbandId, geberId, nurVerwaist, von, jetzt }) => (await db.query(
  `update delegationen set beendet_am = $1, beendet_von = $2
    where beendet_am is null and ($3::uuid is null or id = $3) and ($4::uuid is null or verein_id = $4) and ($5::uuid is null or verband_id = $5)
      and ($6::uuid is null or geber_id = $6) and (not $7 or verwaist_seit is not null) returning ${SPALTEN}`,
  [jetzt, von, id ?? null, vereinId ?? null, verbandId ?? null, geberId ?? null, !!nurVerwaist])).rows;

/** Der Geber hat die Quelle seines DELEGIEREN verloren: seine Delegationen gelten bis zum Ablauf weiter, sind aber zu prüfen. */
export const delegationenVerwaisen = (db, { geberId, schluessel, vereinId, jetzt }) => db.query(
  `update delegationen set verwaist_seit = $4 where geber_id = $1 and beendet_am is null and verwaist_seit is null and delegiert_aus_quelle is not null
      and ($2::text is null or delegiert_aus_schluessel = $2) and ($3::uuid is null or verein_id = $3)`, [geberId, schluessel ?? null, vereinId ?? null, jetzt]);

export const erhalteneDelegationenBeenden = (db, { benutzerId, vereinId, von, jetzt }) => db.query(
  'update delegationen set beendet_am = $3, beendet_von = $4 where empfaenger_id = $1 and verein_id = $2 and beendet_am is null', [benutzerId, vereinId, jetzt, von]);

export const delegationenAlsQuellen = async (db, { benutzerId, kontext, heute }) => (await db.query(
  `select d.recht || ':' || d.operation as recht, to_jsonb(f) as filter from delegationen d left join datenfilter f on f.id = d.datenfilter_id
    where d.empfaenger_id = $1 and d.beendet_am is null and d.gueltig_von <= $4 and d.gueltig_bis >= $4
      and case $2 when 'verein' then d.verein_id = $3 else d.verband_id = $3 end`, [benutzerId, kontext.art, kontext.id, heute])).rows;

export const vereinsrollenBeenden = (db, { benutzerId, vereinId, von, jetzt }) => db.query(
  'update benutzer_vereinsrollen set beendet_am = $3, beendet_von = $4 where benutzer_id = $1 and verein_id = $2 and beendet_am is null', [benutzerId, vereinId, jetzt, von]);
