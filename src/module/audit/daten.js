export const einfuegen = (db, e) => db.query(
  `insert into audit_log (zeitpunkt, akteur, benutzer_id, anwendung, rolle, stellvertreter, ebene_art, ebene_id,
                          aktion, objekt_art, objekt_id, alt, neu, grund)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [e.zeitpunkt, e.akteur, e.benutzer_id, e.anwendung, e.rolle, e.stellvertreter, e.ebene_art, e.ebene_id,
    e.aktion, e.objekt_art, e.objekt_id, e.alt, e.neu, e.grund]);
