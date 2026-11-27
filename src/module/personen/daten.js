const eine = async (db, sql, p) => (await db.query(sql, p)).rows[0];

export const personAnlegen = (db, p) => eine(db,
  `insert into personen (vorname, nachname, geburtsdatum, geschlecht, nationalitaet, strasse, plz, ort, land, email, telefon,
                         heimatverein_id, judopass_hinweis, geaendert_von)
   values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,'DE'),$10,$11,$12,$13,$14) returning id`,
  [p.vorname, p.nachname, p.geburtsdatum, p.geschlecht, p.nationalitaet, p.strasse, p.plz, p.ort, p.land, p.email, p.telefon,
    p.vereinId, p.judopassId, p.von]);

/** Vergibt die nächste Mitgliedsnummer. Dieselbe Sperre wie der /v1-Import, damit beide Wege nicht dieselbe Nummer ziehen. */
export async function mitgliedschaftAnlegen(db, { personId, vereinId, vorname, nachname, eintritt, von }) {
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`import:${vereinId}`]);
  return eine(db,
    `insert into mitglieder (person_id, verein_id, mitgliedsnr, vorname, nachname, eintritt, geaendert_von)
     select $1::uuid, $2::uuid, coalesce(max(mitgliedsnr), 0) + 1, $3, $4, $5::date, $6::uuid from mitglieder where verein_id = $2
     returning id, mitgliedsnr, status, eintritt`, [personId, vereinId, vorname, nachname, eintritt, von]);
}

export const aufgabeAnlegen = (db, { art, verbandId, personId, jetzt, von }) => db.query(
  'insert into aufgaben (art, verband_id, person_id, erstellt_am, erstellt_von) values ($1,$2,$3,$4,$5)', [art, verbandId, personId, jetzt, von]);

const PERSON = `id, vorname, nachname, geburtsdatum, geschlecht, nationalitaet, strasse, plz, ort, land, email, telefon, heimatverein_id, benutzer_id, email_gesetzt_von, zugriffe_abgefragt_am, konto_unbestaetigt_seit, konto_vergeben_durch, change_seq`;
export const personLesen = (db, id) => eine(db, `select ${PERSON} from personen where id = $1`, [id]);
export const personSperren = (db, id) => eine(db, `select ${PERSON} from personen where id = $1 for no key update`, [id]);
export const mitgliedschaften = async (db, personId) => (await db.query(
  `select id, verein_id, mitgliedsnr, status, eintritt, austritt, change_seq from mitglieder where person_id = $1 and geloescht_am is null order by erstellt_am, id`, [personId])).rows;
export const kontaktAendern = (db, p) => eine(db,
  `update personen set strasse = $2, plz = $3, ort = $4, land = $5, email = $6, telefon = $7, geaendert_von = $8 where id = $1 returning ${PERSON}`,
  [p.id, p.strasse, p.plz, p.ort, p.land, p.email, p.telefon, p.von]);

// ---- Zugriffe ----
const ZUGRIFF = 'id, person_id, benutzer_id, art, umfang, erteilt_von, erteilt_am, freigeschaltet_bis, nachweis_id, ruht_seit, widerrufen_am';
export const zugriffFuer = (db, { personId, benutzerId }) => eine(db,
  `select ${ZUGRIFF} from personen_zugriffe where person_id = $1 and benutzer_id = $2 and widerrufen_am is null`, [personId, benutzerId]);
export const zugriffeVon = async (db, personId) => (await db.query(
  `select ${ZUGRIFF} from personen_zugriffe where person_id = $1 and widerrufen_am is null order by erteilt_am, id`, [personId])).rows;
/** Benutzer, denen einer der Genannten je einen Zugriff auf die Person erteilt hat. */
export const zugriffeErteiltDurch = async (db, { personId, durch }) => (await db.query(
  'select distinct benutzer_id from personen_zugriffe where person_id = $1 and erteilt_von = any($2::uuid[])', [personId, durch])).rows.map((r) => r.benutzer_id);
export const zugriffSperren = (db, { id, personId }) => eine(db,
  `select ${ZUGRIFF} from personen_zugriffe where id = $1 and person_id = $2 and widerrufen_am is null for update`, [id, personId]);
export const zugriffAnlegen = (db, z) => eine(db,
  `insert into personen_zugriffe (person_id, benutzer_id, art, umfang, freigeschaltet_bis, erteilt_von, erteilt_am, nachweis_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning ${ZUGRIFF}`,
  [z.personId, z.benutzerId, z.art, z.umfang, z.bis, z.von, z.jetzt, z.nachweisId]);
export const zugriffBeenden = (db, { id, von, jetzt }) => eine(db,
  `update personen_zugriffe set widerrufen_am = $3, widerrufen_von = $2 where id = $1 returning ${ZUGRIFF}`, [id, von, jetzt]);
export const personenFuerBenutzer = async (db, benutzerId) => (await db.query(
  `select ${PERSON} from personen where benutzer_id = $1
      or id in (select person_id from personen_zugriffe where benutzer_id = $1 and widerrufen_am is null) order by lower(nachname), lower(vorname), id`, [benutzerId])).rows;

// ---- Dokumente ----
const DOKUMENT = 'id, art, dateiname, mime_typ, groesse, erstellt_am, geaendert_am';
export const dokumenteVon = async (db, personId) => (await db.query(
  `select ${DOKUMENT} from dokumente where person_id = $1 and geloescht_am is null order by erstellt_am, id`, [personId])).rows;
export const dokumentInhalt = (db, { id, personId }) => eine(db,
  'select art, dateiname, mime_typ, inhalt from dokumente where id = $1 and person_id = $2 and geloescht_am is null', [id, personId]);
export const dokumentAnlegen = (db, d) => eine(db,
  `insert into dokumente (person_id, verein_id, art, dateiname, mime_typ, groesse, inhalt, geaendert_von) values ($1,$2,$3,$4,$5,$6,$7,$8) returning ${DOKUMENT}`,
  [d.personId, d.vereinId, d.art, d.name, d.mime, d.inhalt.length, d.inhalt, d.von]);
export const passfotoErsetzen = (db, d) => eine(db,
  `update dokumente set dateiname = $2, mime_typ = $3, groesse = $4, inhalt = $5, geaendert_von = $6
    where person_id = $1 and art = 'passfoto' and geloescht_am is null returning ${DOKUMENT}`, [d.personId, d.name, d.mime, d.inhalt.length, d.inhalt, d.von]);
export const nachweisBestaetigen = (db, d) => eine(db,
  `update dokumente set bestaetigt_am = coalesce(bestaetigt_am, $3), bestaetigt_von = coalesce(bestaetigt_von, $4)
    where id = $1 and person_id = $2 and art = 'vormundschaftsnachweis' and geloescht_am is null returning ${DOKUMENT}, bestaetigt_am`, [d.id, d.personId, d.jetzt, d.von]);

// ---- Konto und Volljährigkeit ----
export const personZuKonto = (db, benutzerId) => eine(db, `select ${PERSON} from personen where benutzer_id = $1 order by id limit 1`, [benutzerId]);
export const ruhensKandidaten = async (db, tag) => (await db.query(
  `select z.id, z.art, z.freigeschaltet_bis, p.geburtsdatum from personen_zugriffe z join personen p on p.id = z.person_id
    where z.widerrufen_am is null and z.ruht_seit is null and z.art <> 'vormund' and p.geburtsdatum <= $1::date - interval '18 years'
      and (z.freigeschaltet_bis is null or z.freigeschaltet_bis < $1::date) order by z.id for update of z`, [tag])).rows;
export const zugriffRuht = (db, { id, jetzt }) => eine(db, `update personen_zugriffe set ruht_seit = $2 where id = $1 returning ${ZUGRIFF}`, [id, jetzt]);
export const zugriffFreischalten = (db, { id, bis }) => eine(db,
  `update personen_zugriffe set freigeschaltet_bis = $2, ruht_seit = null where id = $1 returning ${ZUGRIFF}`, [id, bis]);
export const abfrageMerken = (db, { id, tag }) => db.query('update personen set zugriffe_abgefragt_am = $2 where id = $1', [id, tag]);

// ---- Mitgliedschaftsantrag ----
export const personZuPass = async (db, { nummer, nachname, geburtsdatum }) => (await eine(db, 'select person_zu_pass($1, $2, $3::date) as id', [nummer, nachname, geburtsdatum])).id;
/** Sperrt je Verein und Benutzer (immer in dieser Reihenfolge), damit parallele Versuche die Grenze nicht überholen. */
export async function fehlversucheSperren(db, vereinId, benutzerId) {
  await db.query('select pg_advisory_xact_lock(hashtextextended($1::text, 2))', [vereinId]);
  await db.query('select pg_advisory_xact_lock(hashtextextended($1::text, 3))', [benutzerId]);
}
export const fehlversuche = (db, { vereinId, benutzerId, seit }) => eine(db,
  `select count(*) filter (where verein_id = $1)::int as verein, count(*) filter (where benutzer_id = $2)::int as benutzer
     from antrag_fehlversuche where zeitpunkt > $3 and (verein_id = $1 or benutzer_id = $2)`, [vereinId, benutzerId, seit]);
export const fehlversuchMerken = (db, { vereinId, benutzerId, jetzt }) => db.query(
  'insert into antrag_fehlversuche (verein_id, benutzer_id, zeitpunkt) values ($1,$2,$3)', [vereinId, benutzerId, jetzt]);
/** Auch gelöschte und ausgetretene: je Person und Verein gibt es nur eine Zeile. */
export const mitgliedschaftIn = (db, { personId, vereinId }) => eine(db,
  'select id, status, geloescht_am from mitglieder where person_id = $1 and verein_id = $2 for update', [personId, vereinId]);
export const mitgliedschaftReaktivieren = (db, { id, eintritt, von }) => eine(db,
  `update mitglieder set status = 'aktiv', austritt = null, kuendigung_am = null, geloescht_am = null, eintritt = coalesce($2::date, eintritt), geaendert_von = $3
    where id = $1 returning id, mitgliedsnr, status, eintritt`, [id, eintritt, von]);

const ANTRAG = `id, verein_id, person_id, vorname, nachname, geburtsdatum, judopass_nr, angaben, gestellt_von, erfasst_von, status, grund, erstellt_am, entschieden_am, erinnert_am, change_seq`;
export const antragAnlegen = (db, a) => eine(db,
  `insert into mitgliedschaftsantraege (verein_id, person_id, vorname, nachname, geburtsdatum, judopass_nr, angaben, gestellt_von, erfasst_von, erstellt_am, geaendert_von)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning ${ANTRAG}`,
  [a.vereinId, a.personId, a.vorname, a.nachname, a.geburtsdatum, a.judopassNr, a.angaben ?? null, a.gestelltVon ?? null, a.erfasstVon ?? null, a.jetzt, a.von]);
export const antragSperren = (db, id) => eine(db, `select ${ANTRAG} from mitgliedschaftsantraege where id = $1 for update`, [id]);
export const antragLesen = (db, { id, vereinId }) => eine(db, `select ${ANTRAG} from mitgliedschaftsantraege where id = $1 and verein_id = $2`, [id, vereinId]);
export const antraegeVon = async (db, { vereinId, status }) => (await db.query(
  `select ${ANTRAG} from mitgliedschaftsantraege where verein_id = $1 and ($2::text is null or status = $2) order by erstellt_am, id`, [vereinId, status])).rows;
export const antraegeFuer = async (db, { benutzerId, personIds }) => (await db.query(
  `select ${ANTRAG} from mitgliedschaftsantraege where gestellt_von = $1 or person_id = any($2::uuid[]) order by erstellt_am desc, id`, [benutzerId, personIds])).rows;
export const offeneAntraege = async (db) => (await db.query(`select id, verein_id from mitgliedschaftsantraege where status = 'offen' order by erstellt_am, id`)).rows;
export const antragEntscheiden = (db, a) => eine(db,
  `update mitgliedschaftsantraege set status = $2, person_id = $3, grund = $4, entschieden_von = $5, entschieden_am = $6, geaendert_von = $5, angaben = null, judopass_nr = null
    where id = $1 returning ${ANTRAG}`, [a.id, a.status, a.personId, a.grund ?? null, a.von, a.jetzt]);
export const antragErinnert = (db, { id, jetzt }) => db.query('update mitgliedschaftsantraege set erinnert_am = $2 where id = $1', [id, jetzt]);

// ---- Austritt ----
/** Je Verein nacheinander: zwei Admins können nicht gleichzeitig als jeweils vorletzter austreten. */
export const austrittImVereinSperren = (db, vereinId) => db.query('select pg_advisory_xact_lock(hashtextextended($1::text, 4))', [vereinId]);
const MITGLIED = 'id, person_id, verein_id, mitgliedsnr, status, eintritt, austritt, kuendigung_am, change_seq';
export const mitgliedSperren = (db, { id, vereinId }) => eine(db,
  `select ${MITGLIED} from mitglieder where id = $1 and verein_id = $2 and geloescht_am is null and anonymisiert_am is null for update`, [id, vereinId]);
export const austrittSetzen = (db, { id, austritt, kuendigung, von }) => eine(db,
  `update mitglieder set austritt = $2, kuendigung_am = $3, geaendert_von = $4 where id = $1 returning ${MITGLIED}`, [id, austritt, kuendigung, von]);
export const austrittVollziehen = (db, { id, von }) => eine(db,
  `update mitglieder set status = 'ausgetreten', geaendert_von = coalesce($2, geaendert_von) where id = $1 returning ${MITGLIED}`, [id, von]);
export const faelligeAustritte = async (db, tag) => (await db.query(
  `select id, verein_id from mitglieder where status <> 'ausgetreten' and austritt <= $1::date and geloescht_am is null and anonymisiert_am is null order by austritt, id`, [tag])).rows;

// ---- Gruppen ----
const GRUPPE = 'id, verein_id, name, trainingszeiten, sortierung, change_seq';
export const gruppenVon = async (db, vereinId) => (await db.query(
  `select ${GRUPPE} from gruppen where verein_id = $1 and geloescht_am is null order by sortierung, lower(name), id`, [vereinId])).rows;
export const gruppeLesen = (db, { id, vereinId }) => eine(db, `select ${GRUPPE} from gruppen where id = $1 and verein_id = $2 and geloescht_am is null`, [id, vereinId]);
export const gruppeSperren = (db, { id, vereinId }) => eine(db, `select ${GRUPPE} from gruppen where id = $1 and verein_id = $2 and geloescht_am is null for update`, [id, vereinId]);
export const gruppeAnlegen = (db, g) => eine(db,
  `insert into gruppen (verein_id, name, trainingszeiten, sortierung, geaendert_von) values ($1,$2,$3,$4,$5) returning ${GRUPPE}`, [g.vereinId, g.name, g.trainingszeiten, g.sortierung, g.von]);
export const gruppeAendern = (db, g) => eine(db,
  `update gruppen set name = $2, trainingszeiten = $3, sortierung = $4, geaendert_von = $5 where id = $1 returning ${GRUPPE}`, [g.id, g.name, g.trainingszeiten, g.sortierung, g.von]);
export const gruppeLoeschen = (db, { id, jetzt, von }) => db.query('update gruppen set geloescht_am = $2, geaendert_von = $3 where id = $1', [id, jetzt, von]);
export const gruppeLeeren = (db, { id, jetzt, von }) => db.query(
  'update mitglied_gruppen set geloescht_am = $2, geaendert_von = $3 where gruppe_id = $1 and geloescht_am is null', [id, jetzt, von]);
export const gruppenMitglieder = async (db, { id, vereinId }) => (await db.query(
  `select m.id, m.person_id, m.mitgliedsnr, m.vorname, m.nachname, m.status from mitglied_gruppen g join mitglieder m on m.id = g.mitglied_id
    where g.gruppe_id = $1 and g.verein_id = $2 and g.geloescht_am is null and m.geloescht_am is null order by lower(m.nachname), lower(m.vorname), m.id`, [id, vereinId])).rows;
/** Unveränderte Zuordnungen bleiben unberührt, damit der Abgleich sie nicht erneut liefert. */
export const gruppeEintragen = (db, g) => db.query(
  `insert into mitglied_gruppen (verein_id, mitglied_id, gruppe_id, geaendert_von) values ($1,$2,$3,$4)
   on conflict (mitglied_id, gruppe_id) do update set geloescht_am = null, geaendert_von = excluded.geaendert_von where mitglied_gruppen.geloescht_am is not null`,
  [g.vereinId, g.mitgliedId, g.id, g.von]);
export const gruppeAustragen = async (db, { id, mitgliedId, jetzt, von }) => (await db.query(
  'update mitglied_gruppen set geloescht_am = $3, geaendert_von = $4 where gruppe_id = $1 and mitglied_id = $2 and geloescht_am is null', [id, mitgliedId, jetzt, von])).rowCount === 1;
export const gruppenAustragen = (db, { mitgliedId, jetzt, von }) => db.query(
  'update mitglied_gruppen set geloescht_am = $2, geaendert_von = coalesce($3, geaendert_von) where mitglied_id = $1 and geloescht_am is null', [mitgliedId, jetzt, von]);

// ---- Transfer ----
const TRANSFER = `id, person_id, von_verein_id, von_mitgliedschaft, nach_verein_id, nach_mitgliedschaft, art, status, wirksam_ab::text as wirksam_ab, reaktivieren, grund,
  gesendet_im_kontext, gesendet_von, erstellt_am, entschieden_am, change_seq`;
const MIT_PERSON = `select t.id, t.person_id, t.von_verein_id, t.von_mitgliedschaft, t.nach_verein_id, t.nach_mitgliedschaft, t.art, t.status, t.wirksam_ab::text as wirksam_ab, t.reaktivieren, t.grund,
  t.gesendet_im_kontext, t.erstellt_am, t.entschieden_am, t.change_seq, p.vorname, p.nachname, p.geburtsdatum::text as geburtsdatum from transfers t join personen p on p.id = t.person_id`;
export const transferAnlegen = (db, t) => eine(db,
  `insert into transfers (person_id, von_verein_id, von_mitgliedschaft, nach_verein_id, nach_mitgliedschaft, art, wirksam_ab, gesendet_von, gesendet_im_kontext, erstellt_am, geaendert_von)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$8) returning ${TRANSFER}`,
  [t.personId, t.vonVereinId, t.vonMitgliedschaft, t.nachVereinId, t.nachMitgliedschaft, t.art, t.wirksamAb, t.von, t.kontext, t.jetzt]);
export const transferSperren = (db, id) => eine(db, `select ${TRANSFER} from transfers where id = $1 for update`, [id]);
export const transferMitPerson = (db, id) => eine(db, `${MIT_PERSON} where t.id = $1`, [id]);
export const transfersVon = async (db, { vereinId, richtung, status }) => (await db.query(
  `${MIT_PERSON} where ${richtung === 'eingehend' ? 't.nach_verein_id' : 't.von_verein_id'} = $1 and ($2::text is null or t.status = $2) order by t.erstellt_am desc, t.id`, [vereinId, status])).rows;
/** Für Story 3.11: Zusammenführen ist gesperrt, solange die Person einen offenen Transfer hat. */
export const offenerTransfer = (db, personId) => eine(db, `select ${TRANSFER} from transfers where person_id = $1 and status in ('gesendet', 'angenommen')`, [personId]);
export const transferEntscheiden = (db, t) => eine(db,
  `update transfers set status = $2, grund = coalesce($3, grund), reaktivieren = coalesce($4, reaktivieren), entschieden_von = coalesce($5, entschieden_von),
          entschieden_am = $6, geaendert_von = coalesce($5, geaendert_von) where id = $1 returning ${TRANSFER}`,
  [t.id, t.status, t.grund ?? null, t.reaktivieren ?? null, t.von, t.jetzt]);
export const faelligeTransfers = async (db, tag) => (await db.query(
  `select id from transfers where status = 'angenommen' and wirksam_ab <= $1::date order by wirksam_ab, id`, [tag])).rows;
export const mitgliedLesen = (db, { id, personId }) => eine(db,
  `select ${MITGLIED} from mitglieder where id = $1 and person_id = $2 and geloescht_am is null and anonymisiert_am is null for update`, [id, personId]);
export const heimatSetzen = (db, { personId, vereinId, von }) => db.query('update personen set heimatverein_id = $2, geaendert_von = coalesce($3, geaendert_von) where id = $1', [personId, vereinId, von]);
export const austrittBeiTransfer = (db, { id, tag, von }) => eine(db,
  `update mitglieder set austritt = least(coalesce(austritt, $2::date), $2::date), geaendert_von = coalesce($3, geaendert_von) where id = $1 returning ${MITGLIED}`, [id, tag, von]);

// ---- Personensuche des Landesverbands und Aufgaben ----
const wildcardFrei = (s) => s.replace(/[\\%_]/g, '\\$&');
/**
 * Höchstens `limit` Personen. Mit Judopass-ID gilt kein Gebiet (nur die Treffer der ID); sonst nur Personen mit Mitgliedschaft in `vereine`.
 * Status und Zeitraum beziehen sich auf eine solche Mitgliedschaft im Gebiet. Ohne Kontaktdaten.
 */
export async function personenSuchen(db, f) {
  const p = []; const w = []; const arg = (v) => { p.push(v); return `$${p.length}`; };
  const gebiet = arg(f.vereine);
  if (f.judopassId) w.push(`pe.id in (select personen_zu_judopass(${arg(f.judopassId)}))`);
  if (f.nachname) w.push(`lower(pe.nachname) like lower(${arg(`${wildcardFrei(f.nachname)}%`)}) escape '\\'`);
  if (f.vorname) w.push(`lower(pe.vorname) like lower(${arg(`${wildcardFrei(f.vorname)}%`)}) escape '\\'`);
  if (f.geburtsdatum) w.push(`pe.geburtsdatum = ${arg(f.geburtsdatum)}::date`);
  const m = ['m.person_id = pe.id', `m.verein_id = any(${gebiet}::uuid[])`, 'm.geloescht_am is null', 'm.anonymisiert_am is null'];
  if (f.vereinId) m.push(`m.verein_id = ${arg(f.vereinId)}::uuid`);
  if (f.status === 'aktiv') m.push(`m.status = 'aktiv'`);
  if (f.status === 'ausgetreten') m.push(`m.status = 'ausgetreten'`);
  if (f.zeitraumBis) m.push(`(m.eintritt is null or m.eintritt <= ${arg(f.zeitraumBis)}::date)`);
  if (f.zeitraumVon) m.push(`(m.austritt is null or m.austritt >= ${arg(f.zeitraumVon)}::date)`);
  const imGebiet = `exists (select 1 from mitglieder m where m.person_id = pe.id and m.verein_id = any(${gebiet}::uuid[]) and m.geloescht_am is null and m.anonymisiert_am is null)`;
  // Mit ID dürfen Treffer außerhalb liegen, solange kein Vereins-, Status- oder Zeitraumfilter ein Mitglied im Gebiet verlangt
  const mitMitgliedschaft = !f.judopassId || f.vereinId || f.status || f.zeitraumVon || f.zeitraumBis;
  if (mitMitgliedschaft) w.push(`exists (select 1 from mitglieder m where ${m.join(' and ')})`);
  return (await db.query(
    `select pe.id, pe.vorname, pe.nachname, pe.geburtsdatum::text as geburtsdatum, pe.heimatverein_id, ${imGebiet} as im_gebiet
       from personen pe where ${w.join(' and ')} order by lower(pe.nachname), lower(pe.vorname), pe.id limit ${arg(f.limit)}`, p)).rows;
}
export const suchenProtokollieren = (db, s) => db.query(
  'insert into personensuchen (benutzer_id, verband_id, zeitpunkt, kriterien, treffer) values ($1,$2,$3,$4,$5)', [s.benutzerId, s.verbandId, s.jetzt, s.kriterien, s.treffer]);

const AUFGABE = 'a.id, a.art, a.status, a.erstellt_am, a.erledigt_am, a.person_id, pe.vorname, pe.nachname, pe.geburtsdatum::text as geburtsdatum, pe.heimatverein_id, pe.judopass_hinweis';
export const aufgabenVon = async (db, { verbandIds, status }) => (await db.query(
  `select ${AUFGABE} from aufgaben a join personen pe on pe.id = a.person_id where a.verband_id = any($1::uuid[]) and ($2::text is null or a.status = $2) order by a.erstellt_am, a.id`, [verbandIds, status])).rows;
export const aufgabeSperren = (db, id) => eine(db, 'select id, verband_id, status from aufgaben where id = $1 for update', [id]);
export const aufgabeMitPerson = (db, id) => eine(db, `select ${AUFGABE} from aufgaben a join personen pe on pe.id = a.person_id where a.id = $1`, [id]);
export const aufgabeErledigen = (db, { id, von, jetzt }) => db.query(`update aufgaben set status = 'erledigt', erledigt_am = $3, erledigt_von = $2 where id = $1`, [id, von, jetzt]);
