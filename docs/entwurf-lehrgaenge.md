# Entwurf: Lehrgänge

Stand: 2026-11-21 · Status: **Entwurf** · Projekt: Stammdaten-Server
Teil von [entwurf-rollen-rechte-lizenzen.md](entwurf-rollen-rechte-lizenzen.md); Begriffe, Rechte-Modell und Kontext stehen dort. Rechnungslauf, Konten und Mandate für den Einzug der Lehrgangsgebühren stehen in [entwurf-finanzen.md](entwurf-finanzen.md).
Abschnitts- und Entscheidungsnummern sind wie im Kerndokument beibehalten.
Im zentralen Kalender erscheinen Lehrgänge neben Prüfungen, Turnieren und Veranstaltungen:
[entwurf-kalender-veranstaltungen.md](entwurf-kalender-veranstaltungen.md).

---

## 9a. Lehrgänge

Vereine und Verbände bieten **Lehrgänge** an (z. B. Kata-Lehrgang des Kreises, Dan-Vorbereitung des Bezirks,
Trainer-B-Ausbildung des Landesverbands). Personen melden sich an; die Teilnahme wird nachweisbar und dauerhaft
gespeichert. Eine erfolgreiche Teilnahme kann eine **Lizenz erteilen**.

### 9a.1 Lehrgangstypen

Jeder Lehrgang gehört zu einem **Lehrgangstyp**. Ein Verband (DJB oder Landesverband) legt Typen an und bestimmt
für jeden Typ **Voraussetzungen**, **Ergebnis** und **wer den Erfolg bestätigen (erteilen) darf**. Neue Typen können jederzeit
angelegt werden (Recht `lehrgangstyp:ANLEGEN/ÄNDERN` im Verbandskontext, z. B. Landesverbands-Admin, DJB-Admin).

**Beispiel „Trainer B“** (Typ des Landesverbands):

| Teil | Festlegung |
|---|---|
| Voraussetzung | Graduierung mindestens 1. Dan **und** gültige Lizenz Trainer C |
| Ergebnis | erfolgreiche Teilnahme erteilt die Lizenz **Trainer B** |
| Beantragen / Freigeben | jeder darf beantragen; die zuständige Stelle der Ebene gibt frei (9a.2) |
| Erteilen (Erfolg bestätigen) | z. B. Inhaber der Lizenz „Ausbilder Trainer B“ im Landesverband |

```sql
create table lehrgangstypen (
  id uuid primary key,
  verband_id uuid not null references verbaende,          -- wer den Typ festlegt (DJB, Landesverband)
  schluessel text not null, name text not null, beschreibung text,
  mit_erfolgskontrolle boolean not null default false,    -- true: Ergebnis erfolgreich/nicht erfolgreich statt nur Anwesenheit
  lerneinheiten numeric(4,1),
  aktiv boolean not null default true,
  unique (verband_id, schluessel)
);
create table lehrgangstyp_voraussetzungen (               -- alle müssen erfüllt sein (UND)
  id uuid primary key,
  lehrgangstyp_id uuid not null references lehrgangstypen on delete cascade,
  art text not null check (art in ('graduierung','lizenz','mindestalter')),
  min_rang      smallint,                                 -- bei 'graduierung' (Rangskala aus 7)
  lizenzart_id  uuid references lizenzarten,              -- bei 'lizenz'
  lizenz_muss_gueltig_sein boolean not null default true,
  mindestalter_jahre int,                                 -- bei 'mindestalter'
  check ((art = 'graduierung') = (min_rang is not null)),
  check ((art = 'lizenz') = (lizenzart_id is not null)),
  check ((art = 'mindestalter') = (mindestalter_jahre is not null))
);
create table lehrgangstyp_ergebnisse (                    -- was eine erfolgreiche Teilnahme bewirkt
  lehrgangstyp_id uuid not null references lehrgangstypen on delete cascade,
  lizenzart_id    uuid not null references lizenzarten,   -- erteilte Lizenz
  laufzeit_monate int,                                    -- leer = Standardlaufzeit der Lizenzart
  primary key (lehrgangstyp_id, lizenzart_id)
);
create table lehrgangstyp_befugnisse (                    -- wer darf erteilen (Erfolg bestätigen)
  id uuid primary key,
  lehrgangstyp_id uuid not null references lehrgangstypen on delete cascade,
  aktion text not null check (aktion = 'erteilen'),
  rolle_id     uuid references rollen,
  lizenzart_id uuid references lizenzarten,
  check (num_nonnulls(rolle_id, lizenzart_id) = 1)
);
```

Typ und Befugnis gelten nur im **Bereich des Verbands, der den Typ festgelegt hat** (Teilbaum). Ein Typ des NWJV
(Nordrhein-Westfalen) kann also nicht in Bayern genutzt werden. Ein DJB-Typ gilt überall. Die erteilte Lizenz muss zu
`lizenzarten.ausstellende_ebenen` passen (Verband des Typs = ausstellender Verband).

Typen werden nicht gelöscht, sondern deaktiviert (`aktiv = false`), solange Lehrgänge darauf verweisen. Beim Freigeben
eines Lehrgangs speichert der Server die Voraussetzungen des Typs als Kopie am Lehrgang (`voraussetzungen_stand`);
Anmeldung und Abschluss prüfen gegen diese Kopie.

### 9a.2 Rechte

| Recht | Operationen | Bedeutung |
|---|---|---|
| `lehrgangstyp` | LESEN, ANLEGEN, ÄNDERN, LÖSCHEN, DELEGIEREN | Lehrgangstypen mit Voraussetzungen, Ergebnissen und Befugnissen pflegen (Verband) |
| `lehrgang` | LESEN, ANLEGEN, ÄNDERN, LÖSCHEN | Lehrgang beantragen, eigenen Antrag ändern oder zurückziehen – **jeder angemeldete Benutzer** (vorerst) |
| `lehrgang_freigabe` | ÄNDERN | beantragten Lehrgang freigeben, ablehnen, absagen; Gebühr ändern (siehe Zuständigkeit unten) |
| `lehrgang_teilnahme` | LESEN, ÄNDERN | Teilnehmerliste, Anwesenheit; Erfolg bestätigen nur mit Befugnis „erteilen“ |

**Zuständig für die Freigabe** (E68, E80) ist je nach Ebene des Veranstalters:

| Veranstalter | gibt frei |
|---|---|
| Verein oder Kreis | Kreis-Dan-Vorsitzender des Kreises (jeder Verein hängt an einem Kreis, E101) |
| Bezirk | Bezirks-Dan-Beauftragter |
| Landesverband | Rolle Lehrgangsfreigabe des Landesverbands |
| DJB | Rolle Lehrgangsfreigabe des DJB |

Lehrgänge ohne Lizenz-Ergebnis (z. B. Kata-Training eines Vereins) nutzen einen einfachen Typ ohne Ergebnis; auch sie
werden beantragt und freigegeben.

### 9a.3 Lehrgang und Anmeldung

```sql
create table lehrgaenge (
  id uuid primary key,
  lehrgangstyp_id uuid not null references lehrgangstypen,
  veranstalter_verein_id  uuid references vereine,
  veranstalter_verband_id uuid references verbaende,
  offen_fuer_verband_id   uuid not null references verbaende,  -- Teilnehmerkreis: Kreis/Bezirk/Land/DJB; bei Anlage
                                                          -- vorbelegt mit dem Veranstalter-Verband bzw. Kreis des Vereins
  titel text not null, beschreibung text,
  beginn timestamptz not null, ende timestamptz not null, ort text,
  leitung text, verantwortlich uuid references benutzer,
  max_teilnehmer int check (max_teilnehmer is null or max_teilnehmer > 0),
  anmeldeschluss timestamptz,
  mindestalter_jahre int,                                 -- zusätzlich zu den Voraussetzungen des Typs
  gebuehr_cent int not null default 0 check (gebuehr_cent >= 0),  -- trägt der Antragsteller ein; der Freigebende kann sie ändern
  gebuehr_geaendert_von uuid references benutzer,
  abrechnender_verband_id uuid not null references verbaende,  -- Gläubiger; vom Server abgeleitet (9a.6)
  voraussetzungen_stand jsonb,                            -- Kopie der Typ-Voraussetzungen bei Freigabe
  teilnehmer_anzahl int,                                  -- beim Abschluss festgeschrieben (bleibt nach Anonymisierung)
  status text not null default 'entwurf'
         check (status in ('entwurf','beantragt','abgelehnt','ausgeschrieben','abgesagt','durchgefuehrt','abgeschlossen')),
  beantragt_von uuid references benutzer, freigegeben_von uuid references benutzer, freigegeben_am timestamptz,
  abgeschlossen_von uuid references benutzer, abgeschlossen_am timestamptz,
  check (num_nonnulls(veranstalter_verein_id, veranstalter_verband_id) = 1),
  check (ende >= beginn),
  check (anmeldeschluss is null or anmeldeschluss <= beginn)
);
-- Serverprüfung: offen_fuer_verband_id enthält den Veranstalter und liegt im Bereich des Typs
create table lehrgang_anmeldungen (
  id uuid primary key,
  lehrgang_id uuid not null references lehrgaenge,
  person_id   uuid not null references personen,
  verein_id   uuid references vereine,                    -- über welchen Verein angemeldet (nur Information; zahlen tut die Person)
  angemeldet_von uuid not null references benutzer,       -- Person selbst, Elternteil oder Verein
  angemeldet_am timestamptz not null default now(),         -- Reihenfolge der Warteliste
  zahlungsweise text check (zahlungsweise in ('lastschrift','ueberweisung')),   -- bei Anmeldung gewählt
  mandat_id uuid references sepa_mandate,
  zahlungspflichtiger_person_id uuid references personen,   -- Kontoinhaber (z. B. Elternteil)
  status text not null default 'angemeldet'
         check (status in ('angemeldet','warteliste','abgemeldet','teilgenommen','nicht_erschienen')),
  ergebnis text check (ergebnis in ('erfolgreich','nicht_erfolgreich')),   -- nur bei Typ mit Erfolgskontrolle
  erteilte_lizenz_id uuid references lizenzen,
  bestaetigt_von uuid references benutzer, bestaetigt_am timestamptz,
  unique (lehrgang_id, person_id)
);
create table lehrgang_nachweise (            -- unveränderlicher Teilnahmenachweis
  id uuid primary key,
  anmeldung_id uuid not null references lehrgang_anmeldungen,   -- je Anmeldung ein nicht widerrufener Nachweis
  person_id uuid not null references personen,
  lehrgang_id uuid not null references lehrgaenge,
  lehrgangstyp_id uuid not null references lehrgangstypen,  -- für Pflichtlehrgänge (Kern 8.1)
  titel text not null, datum_von date not null, datum_bis date not null,
  veranstalter text not null, lerneinheiten numeric(4,1),
  ergebnis text check (ergebnis in ('teilgenommen','erfolgreich','nicht_erfolgreich')),
  erteilte_lizenz text,
  ausgestellt_am timestamptz not null default now(),
  signatur text not null,                    -- Ed25519 über die Felder oben
  schluessel_id uuid not null references signaturschluessel,
  pruefcode text not null unique,            -- kurzer Code zum Prüfen der Bescheinigung
  widerrufen_am timestamptz, widerruf_grund text
);
create unique index nachweis_je_anmeldung on lehrgang_nachweise (anmeldung_id) where widerrufen_am is null;
```

Die Anmeldung bleibt je Lehrgang und Person eine Zeile: Meldet sich eine abgemeldete Person erneut an, wird ihre Zeile
wieder auf `angemeldet` bzw. `warteliste` gesetzt (neues `angemeldet_am`).

**Teilnahmekriterien** bei der Anmeldung (alle müssen erfüllt sein):
- alle **Voraussetzungen des Typs** (Graduierung, Lizenzen, Mindestalter);
- das **Mindestalter des Lehrgangs**, falls gesetzt;
- die Person hat eine Mitgliedschaft im **Teilnehmerkreis** (`offen_fuer_verband_id`, z. B. nur Kreis X, nur Bezirk Y, nur Land Z, DJB-weit).

### 9a.4 Ablauf

1. **Beantragen und freigeben:** Jeder angemeldete Benutzer legt einen Lehrgang an (`entwurf`) und beantragt ihn
   (`beantragt`); beides darf nur der Ersteller. Die zuständige Stelle (9a.2) gibt den Lehrgang frei (`ausgeschrieben`)
   oder lehnt ihn mit Grund ab (`abgelehnt`). Erst danach ist die Anmeldung möglich. Nach der Freigabe kann der
   Antragsteller Gebühr, Teilnehmerkreis und Voraussetzungen nicht mehr ändern; die Gebühr ist ab der ersten Anmeldung
   eingefroren.
2. **Anmelden:** bis zum Anmeldeschluss durch die **Person selbst** (ab 14), ihre **Berechtigten** (4.4, z. B. Eltern) oder
   ihren **Verein**. Der Server prüft die Teilnahmekriterien. Ist der Lehrgang voll, kommt die Person auf die
   **Warteliste** (Reihenfolge nach `angemeldet_am`) und rückt bei Abmeldungen automatisch nach (Sperre auf den
   Lehrgang, `select … for update`). Die Wartelisten-Anmeldung wird mit dem Nachrücken verbindlich: Dann entsteht
   sofort die Forderung, und die Person wird benachrichtigt. Bis dahin kann sie jederzeit kostenfrei stornieren.
   Nachgerückt wird nur bis zum Anmeldeschluss; beim Nachrücken prüft der Server die Teilnahmekriterien erneut.
3. **Durchführen:** Die Leitung bestätigt je Person `teilgenommen` oder `nicht_erschienen`. Bei Typen mit
   Erfolgskontrolle bestätigt ein zum **Erteilen** Befugter zusätzlich `erfolgreich` oder `nicht_erfolgreich`.
4. **Abschließen** (eine Transaktion):
   - Teilnahmen werden festgeschrieben, für jede Teilnahme mit `teilgenommen` entsteht ein **signierter Nachweis**.
   - Für jede **erfolgreiche** Teilnahme prüft der Server die Voraussetzungen erneut (z. B. Trainer C noch gültig) und
     **erteilt oder verlängert die Lizenz(en)** laut Typ. Ist eine Voraussetzung inzwischen weggefallen, wird nichts
     erteilt und der Fall der Leitung angezeigt. Bei Typen ohne Erfolgskontrolle gilt `teilgenommen` als erfolgreich.
     - Hat die Person die Lizenzart **noch nicht**: neue Lizenz, Inhaber = Person, ausgestellt vom Verband des Typs,
       Geltung laut Lizenzart, Laufzeit laut Typ.
     - Hat sie die Lizenzart **bereits** (z. B. Trainer B, Fortbildung): die vorhandene Lizenz wird **verlängert**.
       Die neue Laufzeit beginnt immer am Abschlusstag des Lehrgangs (E122); `gueltig_bis` wird dabei nie verkürzt. Die Verlängerung wird mit Bezug auf den Lehrgang protokolliert.
       Widerrufene Lizenzen werden nicht verlängert, sondern neu erteilt; bei Geltung `verband` wird nur die Lizenz
       mit gleichem `gilt_in_verband_id` verlängert. Fehlt jede Laufzeit (Typ und Lizenzart), gilt die Lizenz unbefristet.
   - Die Lehrgangsgebühren werden als private Forderungen angelegt (9a.6).

### 9a.5 Sichere Ablage

- **Unveränderlich:** Nachweise werden nie geändert oder gelöscht, nur mit Grund **widerrufen**. Korrektur = Widerruf + neuer Nachweis.
- **Signiert:** Signatur über die Nachweisdaten mit dem Server-Schlüssel (wie Tokens und Judopass), damit eine
  Bescheinigung nicht gefälscht werden kann. Schlüsselrotation über `schluessel_id`.
- **Protokolliert:** Anmeldung, Abmeldung, Anwesenheit und Abschluss stehen im `audit_log` (wer, wann, was).
- **Zugriff:** Teilnehmer und Eltern sehen ihre Nachweise dauerhaft (4.4). Der Veranstalter sieht Name, Verein, Grad,
  Geburtsjahr der Angemeldeten – **keine Kontaktdaten** (wie überall auf Verbandsebene). Der Verein sieht die
  Lehrgänge seiner Mitglieder.
- **Aufbewahrung:** Nachweise bleiben erhalten, solange die Person nicht anonymisiert ist. Bei der Anonymisierung werden
  Nachweise und Anmeldungen gelöscht; am Lehrgang bleibt nur die Teilnehmerzahl (`lehrgaenge.teilnehmer_anzahl`).
  Beim Zusammenführen zweier Personen werden Nachweise der Dublette widerrufen und für die führende Person neu
  ausgestellt (neue Signatur).

### 9a.6 Lehrgangsgebühren (privat, immer über den Verband)

Lehrgangsgebühren zahlt die **Person privat** (bei Kindern die Eltern). **Abgerechnet wird immer über den Verband**,
auch wenn ein Verein den Lehrgang ausrichtet. Gläubiger ist der **abrechnende Verband** des Lehrgangs
(`lehrgaenge.abrechnender_verband_id`): Richtet ein Verband aus (Kreis, Bezirk, Land, DJB), ist er es selbst; richtet
ein Verein aus, ist es der Verband des Lehrgangstyps. Der Server leitet ihn ab, er ist nicht frei wählbar. Bei der
Anmeldung wählt der Zahler **Lastschrift** (mit SEPA-Mandat an diesen Verband, 6.5) oder **Überweisung**. Hat der
abrechnende Verband keine Gläubiger-ID oder kein Konto, wird nur Überweisung angeboten.

Die Forderung ist eine Zeile in `abrechnungspositionen` ([6.3](entwurf-finanzen.md), E108) mit `art = 'lehrgang'`,
`bezug_tabelle = 'lehrgang_anmeldungen'`, Zahler = Person, Empfänger = abrechnender Verband; eine eigene Tabelle
`lehrgang_zahlungen` gibt es nicht.

- Die Forderung entsteht **bei der Anmeldung**, auf der Warteliste erst **beim Nachrücken**; bei 0 € entsteht keine.
- Abmeldung vor Anmeldeschluss storniert die Forderung; danach entscheidet der Verband, ob er sie erlässt (`erlassen`).
- Wird der Lehrgang **abgesagt**, storniert der Server alle offenen Forderungen; bereits eingezogene werden erstattet
  (Gutschrift, Überweisung durch den Verband).
- Eingezogen wird im **Rechnungslauf** des Verbands (6.3a).

---

## Testschwerpunkte (Vorschau)

- **P0** Lehrgänge: Anmeldung nur durch Person (ab 14), Eltern oder Verein; Teilnehmerkreis greift; Warteliste rückt bei Abmeldung nach (auch parallel, keine Überbuchung), nach Anmeldeschluss nicht mehr; Wartelisten-Platz erzeugt keine Forderung, Nachrücken schon; erneute Anmeldung nach Abmeldung möglich; nach Abschluss keine Änderung möglich; Nachweis-Signatur prüft, manipulierter Nachweis fällt durch; Veranstalter sieht keine Kontaktdaten.
- **P0** Lehrgangstypen: Anmeldung ohne Voraussetzung (kein 1. Dan oder Trainer C abgelaufen) abgelehnt; Person außerhalb des Teilnehmerkreises abgelehnt; erfolgreiche Teilnahme erteilt genau die Lizenz laut Typ; nicht erfolgreich erteilt nichts; Voraussetzung zwischen Anmeldung und Abschluss weggefallen → keine Lizenz; Freigeben/Erteilen ohne Befugnis abgelehnt; Typ eines anderen Landesverbands nicht nutzbar; Änderung des Typs nach Freigabe wirkt nicht auf den Lehrgang.
- **P0** Lehrgang ↔ Lizenz: vorhandene Lizenz wird verlängert statt doppelt angelegt; Verlängerung verkürzt nie; abgelaufene Lizenz läuft ab Abschlusstag neu; Pflichtlehrgang fehlt → Prüfungsanmeldung abgelehnt.
- **P0** Lehrgang: ohne Freigabe keine Anmeldung; Freigabe nur durch die zuständige Stelle der Ebene (9a.2); fremde Ebene oder fremder Teilbaum → abgelehnt; Antragsteller kann Gebühr nach Freigabe nicht ändern.
- **P0** Lehrgangsgebühr: Absage storniert bzw. erstattet; ohne Gläubiger-ID nur Überweisung; Forderung liegt in `abrechnungspositionen`.

---

## Entscheidungen

| # | Entscheidung |
|---|---|
| E48 | Lehrgänge können angeboten werden; Personen melden sich an; Lehrgänge und Teilnahmen werden sicher (unveränderlich, signiert, protokolliert) gespeichert |
| E50 | Lehrgänge können Graduierungen und/oder Lizenzen voraussetzen; Mindestalter und Teilnehmerkreis (Kreis, Bezirk, Land) sind weitere Kriterien |
| E51 | Eine erfolgreiche Lehrgangsteilnahme kann eine Lizenz erteilen (z. B. Trainer B) |
| E52 | Verbände legen Lehrgangstypen mit Voraussetzungen, Ergebnissen und Befugnis „erteilen“ an (Freigabe: E68) |
| E53 | Lehrgangsgebühren zahlt die Person privat an einen Verband, per Lastschrift oder Überweisung |
| E54 | Ein Lehrgang kann Voraussetzung für eine Prüfung sein (Pflichtlehrgang) |
| E56 | Ein Lehrgang verlängert eine bereits vorhandene Ergebnis-Lizenz |
| E57 | Lehrgänge werden immer über einen Verband abgerechnet; Rechnungsläufe macht nur ein Verband |
| E68 | Lehrgänge darf vorerst jeder beantragen; im Verein bzw. Kreis gibt der Kreis-Dan-Vorsitzende frei, im Bezirk der Bezirks-Dan-Beauftragte, im Landesverband die Rolle „Lehrgangsfreigabe“ |
| E78 | Lehrgangsgebühr entsteht auf der Warteliste erst beim Nachrücken |
| E80 | DJB-Lehrgänge gibt eine Rolle „Lehrgangsfreigabe“ des DJB frei |
| E87 | Die Wartelisten-Anmeldung wird mit dem Nachrücken verbindlich (Forderung entsteht); bis dahin ist sie jederzeit kostenfrei stornierbar |
| E88 | Die Lehrgangsgebühr trägt der Antragsteller ein; der Freigebende kann sie ändern |
| E119 | Voraussetzungen eines Lehrgangs werden bei der Anmeldung und beim Abschluss geprüft |
| E120 | Die Befugnisse eines Lehrgangstyps gelten nur im Teilbaum des Verbands, der den Typ festgelegt hat |
| E121 | Die Lehrgangsgebühr entsteht bei der Anmeldung (Warteliste: beim Nachrücken); Abmeldung vor Anmeldeschluss storniert sie, danach bleibt sie |
| E122 | Verlängert ein Lehrgang eine Lizenz, beginnt die neue Laufzeit am Abschlusstag des Lehrgangs, auch wenn die alte Lizenz noch gültig ist; `gueltig_bis` wird nie verkürzt |
| E123 | Der Pflichtlehrgang wird bei der Anmeldung zur Prüfung geprüft |

## Annahmen

Derzeit keine offenen Annahmen; die Annahmen 16–20 sind als E119–E123 entschieden.
