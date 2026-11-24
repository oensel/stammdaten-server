// Zentrale Liste der auditpflichtigen Aktionen: genau NFR-18. Jede Aktion braucht in ihrer Story einen Audit-Test (AD-6).
export const AKTIONEN = Object.freeze([
  'verband_angelegt', 'verband_geaendert', 'verein_angelegt', 'verein_geaendert', 'verein_verbandswechsel',
  'recht_vergeben', 'recht_entzogen',
  'person_zusammengefuehrt',
  'geloescht',
  'lv_direktaenderung',
  'startrecht_geaendert',
  'pruefung_korrigiert',
  'lehrgang_abgeschlossen', 'lehrgang_freigegeben', 'lehrgang_selbst_freigegeben',
  'stellvertreter_ernannt', 'stellvertreter_entzogen',
  'lizenz_verlaengert',
  'bankdaten_notfallzugriff',
  'gebuehrenregel_geaendert', 'entscheidungsebene_geaendert',
]);
