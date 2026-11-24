# Entwurf: Personen, Rollen, Rechte, Lizenzen, Graduierungen und Prüfungen

Stand: 2026-11-20 · Status: **Entwurf (fachlich abgestimmt, noch kein Test-Design, noch keine Migration)**
Projekt: Stammdaten-Server · Ersetzt nach Freigabe Abschnitt 2.4 in [`datenbankentwurf.md`](datenbankentwurf.md)
und beantwortet dort die offene Entscheidung 2 („Person vereinsübergreifend“).

**Dokumentenset** (Abschnitts-, Entscheidungs- und Annahmenummern sind dokumentübergreifend eindeutig):

| Dokument | Abschnitte | Entscheidungen | Annahmen |
|---|---|---|---|
| dieses Kerndokument | 1–16 (ohne 6.3, 6.3a, 6.5, 6.8, 9a, 9b) | E1–E38 (ohne E19, E30), E44, E46, E47, E49, E63, E67, E70–E76, E79, E81–E84, E86, E89, E97–E107 | 1, 3–6, 8–11, 15, 26 |
| [entwurf-finanzen.md](entwurf-finanzen.md) | 6.3, 6.3a, 6.5, 6.8 (Migration) | E39–E43, E45, E55, E58–E62, E64–E66, E69, E77, E85, E108, E109, E114–E118 | 13 |
| [entwurf-lehrgaenge.md](entwurf-lehrgaenge.md) | 9a.1–9a.6 | E48, E50–E54, E56, E57, E68, E78, E80, E87, E88, E119–E123 | – |
| [entwurf-kalender-veranstaltungen.md](entwurf-kalender-veranstaltungen.md) | 9b.1–9b.7 | E90–E96, E110–E113 | – |

**Stand und offene Punkte:** Review-Runde 3 und Fragerunde 4 eingearbeitet (2026-11-21). Offen sind: Test-Design und
Migrationsskripte.

Die SQL-Ausschnitte sind Skizzen. Sync-Spalten (`erstellt_am`, `geaendert_am`, `geaendert_von`, `geloescht_am`,
`change_seq`) und die Konventionen aus `schema.sql` gelten für alle Tabellen und sind hier weggelassen.

---

## 1. Anforderungen (Zusammenfassung)

1. Der Stammdaten-Server hält alle Benutzer, Mitglieder (Personen), Rollen, Rechte und Lizenzen.
2. **Rechte** werden mit einer **Operation** vergeben: LESEN, ÄNDERN, LÖSCHEN, ANLEGEN, DELEGIEREN.
   DELEGIEREN bedeutet, das Recht anderen geben zu dürfen, ohne es selbst nutzen zu können
   (Beispiel: Admin hat `ueberweisung:DELEGIEREN`, aber nicht `ueberweisung:ANLEGEN`; der Kassierer bekommt `ANLEGEN`).
3. **Rollen** sind eine eigene Tabelle mit einem Set von Rechten. Neue Rollen können angelegt werden.
4. **Lizenzen** sind eine eigene Tabelle. Eine Lizenz kann mehrere Rechte gewähren, kann ablaufen und gilt danach nicht mehr.
   Lizenzen hängen an der Person bzw. dem Benutzer, nicht am Verein.
5. Ein **Benutzer** kann mehreren Vereinen zugeordnet sein und hat je Verein eigene Rollen und Rechte; der Heimatverein steht an der verknüpften Person.
6. Ein **Mitglied** kann in mehreren Vereinen sein, hat genau einen Heimatverein und ist zwischen Vereinen **transferierbar**.
7. Mitglied und Benutzer sind verknüpfbar; nicht jedes Mitglied hat einen Benutzer.
8. **Eltern** melden sich als Benutzer an und verantworten ein oder mehrere (minderjährige) Mitglieder.
9. Rechte gelten nicht nur in Vereinen, sondern auch in **Kreis, Bezirk, Landesverband oder im ganzen DJB**.
10. Die Gürtel eines Mitglieds (Grad, Urkunden-Nr., Datum) sind **Graduierungen**.
11. **Prüfungen** gehören in den Stammdaten-Server.

---

## 2. Begriffe

| Begriff | Bedeutung |
|---|---|
| **Person** | Ein Mensch, unabhängig vom Verein (Name, Geburtsdatum, Nationalität, DJB-ID) |
| **Mitgliedschaft** | Zugehörigkeit einer Person zu einem Verein (Mitgliedsnr., Eintritt, Austritt, Status) |
| **Benutzer** | Anmeldekonto (Single Sign-on für alle Apps); optional mit genau einer Person verknüpft |
| **Recht** | Ein Gegenstand, auf den zugegriffen wird (`mitglieder`, `vereine`, `graduierung`, `pruefung`, `ueberweisung` …) |
| **Operation** | LESEN, ÄNDERN, LÖSCHEN, ANLEGEN, DELEGIEREN – fest, es kommen keine weiteren hinzu |
| **Berechtigung** | Recht × Operation, optional mit Datenfilter |
| **Bereich** | Knoten im Organisationsbaum, in dem eine Berechtigung gilt: ein Verein oder ein Verband (Kreis, Bezirk, Landesverband, DJB) |
| **Datenfilter** | Einschränkung einer Berechtigung auf bestimmte Personen, Werte oder Felder |
| **Quelle** | Woher eine Berechtigung stammt: Vereinsrolle, Verbandsrolle, Lizenz oder direkte Zuweisung |
| **Lizenz** | Ausgestellter, befristbarer Nachweis einer Person (Judopass, Trainer C, Kyu-Prüfer …); kann Berechtigungen gewähren |
| **Graduierung** | Erreichter Grad (Kyu/Dan) einer Person mit Datum und Urkunden-Nr. |
| **Heimatverein** | Verein, bei dem der Judopass der Person liegt (`personen.heimatverein_id`); früher auch „führender Verein“ |
| **Kontext** | Der eine aktive Verein oder Verband einer Sitzung; nur dessen Rechte wirken (11.1) |
| **Transfer** | Übergabe von Pass und Heimatverein an einen anderen Verein: Vereinswechsel oder Heimatwechsel (4.2) |
| **Mitgliedschaftsantrag** | Antrag einer Person auf Mitgliedschaft in einem weiteren Verein, mit Pass-Nr. und Wahl der Pass-Übertragung (4.1a) |
| **Judopass-Antrag** | Antrag des Heimatvereins an den Landesverband: Erteilung, Änderung oder Verlängerung (6.1) |
| **Jahressichtmarke** (früher auch Pass-Marke) | Digitale Marke je Pass und Jahr, kostenpflichtig (6.2) |
| **Prüfungsordnung / Modul** | Regelwerk je Grad; ein Modul ist ein einzeln ablegbarer Teil der Prüfung zum nächsten Grad (8.1) |
| **Lehrgangstyp** | Vorlage für Lehrgänge mit Voraussetzungen, Ergebnis-Lizenzen und Befugnis „erteilen“ (9a.1) |
| **Gläubiger** | Verein oder Verband, der Lastschriften einzieht (Gläubiger-ID, Konto) |
| **Rechnungslauf** | Sammellauf eines Verbands über alle offenen Forderungen mit SEPA-Datei (6.3a) |
| **Abrechnung** | Monatliche Sammelrechnung des Landesverbands an einen Verein (6.3) |

---

## 3. Organisationsbaum

Besteht bereits: `verbaende` (Typ `dachverband`, `landesverband`, `bezirk`, `kreis`, `uebergeordnet_id`) und
`vereine.verband_id`. Der DJB ist die Wurzel; „im ganzen DJB“ ist damit kein Sonderfall.

```sql
-- Vorfahren-Tabelle (oder ltree): "liegt Verein/Verband X unter Verband Y?"
create table verband_pfade (
  ahn_id       uuid not null references verbaende,
  nachfahre_id uuid not null references verbaende,
  tiefe        int  not null,
  primary key (ahn_id, nachfahre_id)
);
-- per Trigger gepflegt bei Änderung von verbaende.uebergeordnet_id; Zyklen werden abgelehnt
-- je Verband eine Selbstzeile (ahn = nachfahre, tiefe 0), damit ein Recht auch im Verband selbst gilt
-- Verein im Bereich: vereine.verband_id liegt in verband_pfade unter dem Bereichsverband (eine SQL-Funktion liegt_unter())
-- Wechselt ein Verein den Verband, wirken Verbandsrechte sofort nach dem neuen Baum; offene Anträge gehen an den neuen Landesverband
```

**Regel:** Eine Berechtigung mit Bereich = Verband gilt für den Verband und den gesamten Teilbaum darunter
(alle untergeordneten Verbände und deren Vereine).

**Jeder Verein hängt an einem Kreis** (E101): `vereine.verband_id` zeigt immer auf einen Verband vom Typ `kreis`
(Trigger-Prüfung). Damit hat jeder Verein genau einen Kreis, Bezirk und Landesverband; Freigabestellen und Empfänger
der Ebene sind immer bestimmbar. Ein aufgelöster Verein bleibt im Baum (`vereine.aufgeloest_am`).

**Verbandswechsel eines Vereins:** Bereits entstandene Abrechnungspositionen, Abrechnungen und Mandate bleiben beim
alten Landesverband, der den laufenden Monat noch abrechnet; neue Positionen ab dem Wechseltag gehen an den neuen.
Die Zahlungsweise muss der Verein beim neuen Landesverband neu festlegen (Standard: Überweisung).

---

## 4. Personen, Mitgliedschaften, Benutzer

### 4.1 Personen und Mitgliedschaften

Die heutige Tabelle `mitglieder` (eine Zeile je Vereinsmitgliedschaft) wird aufgeteilt. Grund: Lizenzen und
Graduierungen müssen einen Vereinswechsel überstehen, ohne kopiert zu werden.

```sql
create table personen (
  id            uuid primary key,
  vorname       text not null,
  nachname      text not null,
  geburtsdatum  date,
  geschlecht    char(1),
  nationalitaet text,
  strasse text, plz text, ort text, land char(2), email text, telefon text,   -- Kontakt (Feldgruppe kontakt)
  djb_id        text unique,
  benutzer_id   uuid unique references benutzer,     -- 0..1 Verknüpfung zum Anmeldekonto
  heimatverein_id uuid not null references vereine   -- Verein, bei dem der Judopass liegt (4.1a)
);
-- deferrable Constraint-Trigger: zu (id, heimatverein_id) existiert eine nicht gelöschte Mitgliedschaft (jeder Status)

create table mitgliedschaften (                       -- = bisheriges "mitglieder" ohne Personenfelder
  id           uuid primary key,
  person_id    uuid not null references personen,
  verein_id    uuid not null references vereine,
  mitgliedsnr  integer not null,                      -- vom Server erzeugt (Zähler je Verein, select … for update)
  eintritt date, kuendigung_am date, austritt date,
  status       text not null default 'aktiv' check (status in ('aktiv','ruhend','ausgetreten')),
  ehrenmitglied boolean not null default false, ausbildung_bis date,
  unique (verein_id, mitgliedsnr),
  unique (person_id, verein_id)
);
```

**Kontaktdaten** (Anschrift, Telefon, E-Mail) liegen einmal an der Person und gelten für alle Vereine.
Ändern dürfen sie der **Heimatverein** (Admin bzw. Rolle mit `mitglieder:ÄNDERN` auf Feldgruppe `kontakt`), die Person
selbst und die Personen mit Zugriff nach 4.4. Andere Vereine der Person lesen sie nur.

### 4.1a Heimatverein und weitere Mitgliedschaft

**Heimatverein = der Verein, bei dem der Judopass liegt.** Er hängt an der Person (`personen.heimatverein_id`), nicht an
einer Mitgliedschaft und nicht am Benutzer. Der Heimatverein stellt die Judopass-Anträge, beantragt die Verlängerung
und pflegt die Kontaktdaten. Er ändert sich **nur**, wenn der Pass übertragen wird. Personen ohne Judopass haben als
Heimatverein den Verein, in dem sie zuerst Mitglied wurden; mit der Erteilung des Passes wird der beantragende Verein
Heimatverein.

Regeln:
- Der Heimatverein muss eine Mitgliedschaft der Person haben, **gleich in welchem Status** (aktiv, ruhend,
  ausgetreten; auch mit gesetztem `kuendigung_am`). `heimatverein_id` ist nie leer (`not null` und Constraint-Trigger).
- Eine Person entsteht immer zusammen mit ihrer ersten Mitgliedschaft (Anlage durch den Verein oder Annahme eines
  Mitgliedschaftsantrags), nie vorher.
- **Austritt aus dem Heimatverein:** Der Austritt ist ohne Weiteres möglich. Ohne Transfer liegen Pass und Person
  weiterhin bei diesem Verein, auch Jahre später. Erst ein Transfer (4.2) ändert den Heimatverein.
- **Verein aufgelöst:** Gibt es den Heimatverein nicht mehr (`vereine.aufgeloest_am`), überträgt der **Landesverband**
  die Person an einen neuen Verein (Transfer im Verbandskontext, Recht `transfer:ANLEGEN`, auch ohne Mitgliedschaft im
  Zielverein). Bis dahin stehen die Personen auf der Liste „Pässe aufgelöster Vereine“ des Landesverbands; die
  Mitgliedschaft im aufgelösten Verein bleibt als `ausgetreten` bestehen.

**Weitere Mitgliedschaft (Zweitverein):** Es gibt **keine Suche** nach Personen über Vereinsgrenzen – weder über die
Judopass-Nr. noch über Name und Geburtsdatum. Wer zusätzlich in Verein B Mitglied werden will, **beantragt die
Mitgliedschaft** dort:

- Die Person (bzw. bei Kindern die Eltern) gibt ihre **Judopass-Nr. an, wenn sie eine hat**.
- Der Antrag **überträgt nie den Pass**. Soll B Heimatverein werden, stößt die Person danach beim bisherigen Heimatverein
  einen Transfer an (Heimatwechsel, 4.2).
- Der Antrag kommt online über das Konto der Person bzw. der Eltern, oder Verein B erfasst einen schriftlichen Antrag.
- Der Server ordnet die Pass-Nr. zusammen mit Nachname und Geburtsdatum der bestehenden Person zu (alle drei müssen
  passen, sonst Ablehnung ohne Hinweis auf den Grund).
- **Ohne Pass-Nr.** (E100): Stellt die Person bzw. ein Elternteil den Antrag **online aus dem eigenen Konto**, wählt sie
  die Person aus den Personen, auf die sie Zugriff hat (sich selbst oder ein Kind, 4.4); der Server übernimmt deren
  `person_id`. Nur ein schriftlicher Antrag ohne Pass-Nr. legt bei der Annahme eine neue Person an.
- Ist die Person in B bereits Mitglied (auch ausgetreten), lehnt der Server den Antrag ab bzw. reaktiviert auf Wunsch von
  B die vorhandene Mitgliedschaft; je Verein und Person gibt es höchstens einen offenen Antrag.
- Verein B sieht vor der Annahme nur die Angaben des Antrags. Nimmt B an, entsteht die Mitgliedschaft; ab dann sieht B die
  personenbezogenen Daten (11.1), aber nichts aus den Mitgliedschaften in anderen Vereinen.
- Bei der Annahme erzeugt der Server die **Mitgliedsnummer** in B (nächste freie Nummer des Vereins).

```sql
create table mitgliedschaftsantraege (
  id uuid primary key,
  verein_id   uuid not null references vereine,            -- beantragter Verein
  person_id   uuid references personen,                    -- gesetzt nach Zuordnung bzw. Neuanlage
  vorname text not null, nachname text not null, geburtsdatum date not null,
  judopass_nr text,                                        -- nur Angabe, keine Suche
  gestellt_von uuid references benutzer,                   -- Person/Eltern online; leer = vom Verein erfasst
  erfasst_von  uuid references benutzer,
  status text not null default 'offen' check (status in ('offen','angenommen','abgelehnt','zurueckgezogen')),
  entschieden_von uuid references benutzer, entschieden_am timestamptz
);
create unique index ein_offener_mitgliedschaftsantrag on mitgliedschaftsantraege (verein_id, person_id)
  where status = 'offen' and person_id is not null;
```

Fehlgeschlagene Zuordnungen werden protokolliert und je Verein mengenbegrenzt (Schutz vor Ausprobieren von Pass-Nummern).

### 4.2 Transfer

Ein Transfer ist ein Workflow, kein Umkopieren. Es gibt zwei Arten:

| Art | Typischer Fall | Mitgliedschaft im abgebenden Verein | Pass / Heimatverein |
|---|---|---|---|
| **Vereinswechsel** | Umzug, Wechsel in einen anderen Verein | endet | geht an den aufnehmenden Verein |
| **Heimatwechsel** | Person ist in A und B Mitglied, der Pass liegt bei A, Heimatverein soll B werden | bleibt bestehen | geht an B |

**Die Person stößt den Transfer an, der Verein mit dem Pass leitet ihn ein.** Die Person bittet den Verein, bei dem ihr
Pass liegt (Heimatverein A), den Transfer einzuleiten. Ist sie im Zielverein B schon Mitglied, kennen beide Vereine
dieselbe Person (gleiche `person_id`); die Zuordnung ist eindeutig, es wird nichts gesucht und nichts neu angelegt.

**Auch inaktive Mitglieder können transferiert werden** (z. B. fünf Jahre ruhend oder bereits ausgetreten, der Pass liegt
aber noch bei A). Abgebend ist dann der Verein, bei dem der Pass liegt, auch wenn die Mitgliedschaft dort nicht mehr
aktiv ist. Im aufnehmenden Verein B gilt:
- Ist die Person in B schon Mitglied (auch ruhend), wird diese Mitgliedschaft genutzt und B wird Heimatverein.
- Sonst legt B bei der Annahme eine neue Mitgliedschaft an; die **Mitgliedsnummer** erzeugt der Server.

**Je Person höchstens ein offener Transfer** (Status `gesendet` oder `angenommen`). Beim Vollzug prüft der Server erneut,
dass der Pass noch beim abgebenden Verein liegt, die Person nicht zusammengeführt wurde und Verein B nicht aufgelöst
ist; sonst erhält der Transfer den Status `abgebrochen` (mit Grund). Solange ein Transfer offen ist, ist das
Zusammenführen der Person gesperrt.

```sql
create table transfers (
  id                  uuid primary key,
  person_id           uuid not null references personen,
  von_mitgliedschaft  uuid not null references mitgliedschaften,   -- darf ruhend oder ausgetreten sein (Pass liegt dort)
  nach_verein_id      uuid not null references vereine,
  art                 text not null check (art in ('vereinswechsel','heimatwechsel')),
  nach_mitgliedschaft uuid references mitgliedschaften,             -- vorhandene Mitgliedschaft in B; leer = bei Annahme neu anlegen
  check (art <> 'heimatwechsel' or nach_mitgliedschaft is not null),  -- Heimatwechsel setzt Mitgliedschaft in B voraus
  foreign key (von_mitgliedschaft, person_id) references mitgliedschaften (id, person_id),
  foreign key (nach_mitgliedschaft, person_id, nach_verein_id) references mitgliedschaften (id, person_id, verein_id),
  -- dafür unique (id, person_id) und unique (id, person_id, verein_id) in mitgliedschaften
  -- Serverprüfung: nach_verein_id <> Verein der von_mitgliedschaft; von_mitgliedschaft gehört zum Heimatverein;
  -- hat die Person in B schon eine Mitgliedschaft, muss nach_mitgliedschaft gesetzt sein
  status              text not null default 'gesendet'
                      check (status in ('gesendet','angenommen','abgelehnt','zurueckgezogen','vollzogen','abgebrochen')),
  wirksam_ab          date not null,                  -- liegt es bei Annahme in der Vergangenheit: sofort vollziehen
  gesendet_von        uuid not null references benutzer,
  gesendet_im_kontext text not null check (gesendet_im_kontext in ('abgebender_verein','landesverband')),
  entschieden_von     uuid references benutzer
);
create unique index transfer_je_person_offen on transfers (person_id)
  where status in ('gesendet','angenommen');
```

**Ablauf: Der abgebende Verein (bei dem der Pass liegt) sendet das Mitglied.**

1. Der **abgebende Verein** (Recht `transfer:ANLEGEN` im Vereinskontext) oder der **Landesverband**
   (`transfer:ANLEGEN` im Verbandskontext, für Vereine in seinem Teilbaum) wählt das Mitglied und die Art des
   Transfers. Wählbar sind auch ruhende und ausgetretene Mitglieder, solange der Pass bei ihm liegt. Ist die Person im
   Zielverein schon Mitglied, schlägt der Server `heimatwechsel` vor.
2. Er **sucht den aufnehmenden Verein** (Vereinssuche nach Name, Vereinsnummer, Ort – öffentliche Vereinsdaten) und
   sendet das Mitglied dorthin. Status `gesendet`.
3. Der **aufnehmende Verein** sieht eingehende Transfers in seinem Kontext und nimmt an (`transfer:ÄNDERN`) oder lehnt ab.
   Vor der Annahme sieht er nur Name, Geburtsdatum und aktuellen Grad der Person, nicht deren Daten aus dem abgebenden Verein.
4. Bis zum Vollzug kann der abgebende Verein bzw. Landesverband den Transfer zurückziehen, auch nach der Annahme.
5. Am Tag `wirksam_ab` wird vollzogen (Status `vollzogen`); ist das Datum bei Annahme schon erreicht, sofort.
6. Ist die Person im Zielverein bereits Mitglied, wird keine neue Mitgliedschaft angelegt (`nach_mitgliedschaft`); eine
   ruhende Mitgliedschaft dort wird auf Wunsch von B wieder aktiv.

**Über Landesgrenzen** (z. B. Umzug von Hamburg nach München): Der abgebende Verein darf an jeden Verein im DJB senden.
Der Landesverband darf nur Mitglieder von Vereinen aus seinem Teilbaum senden, das Ziel darf aber außerhalb liegen.

Beim Transfer findet der aufnehmende Verein keine fremden Mitglieder, er bekommt sie zugesendet. Eine Personensuche
über Vereinsgrenzen gibt es nicht (4.1a).

Beim Vollzug, in einer Transaktion: Der Judopass und damit der Heimatverein (`personen.heimatverein_id`) gehen an B.
Bei `vereinswechsel` erhält die alte Mitgliedschaft `status = 'ausgetreten'` und `austritt = least(austritt, wirksam_ab)`,
bei `heimatwechsel` bleibt sie unverändert. In B wird die vorhandene Mitgliedschaft genutzt oder eine neue angelegt.
Lizenzen und Graduierungen hängen an der Person und bleiben unverändert. Vereinsrollen und Rechte im alten Verein
enden nach der Austrittsregel in 4.3.

**Folgeobjekte beim Vollzug:**

| Objekt | Folge |
|---|---|
| Offene Judopass-Anträge | gehen an B (`gestellt_von_verein_id`) und dessen Landesverband (`an_verband_id`) |
| Bereits entstandene Abrechnungspositionen | bleiben beim bisherigen Zahler und Empfänger (Leistungsdatum zählt) |
| Angemeldete Prüfungen, Lehrgänge, Turniermeldungen | bleiben bestehen; der alte Verein kann sie weiter abmelden |
| Mannschaftsmitgliedschaften des alten Vereins | enden beim `vereinswechsel` mit `wirksam_ab` (`bis`) |

### 4.2a Dubletten: Zusammenführen und Löschen durch den Landesverband

Kann ein Verein Dubletten (dieselbe Person zweimal angelegt) nicht selbst bereinigen, greift der **Landesverband** ein
(im Verbandskontext, für Personen mit Mitgliedschaft in seinem Teilbaum). **Über Landesverbandsgrenzen** (E100) führt
der Landesverband des Heimatvereins der **älteren** Person-Zeile zusammen; er sieht dafür die Dublette im anderen
Landesverband, sobald ein Verein oder der andere Landesverband sie als mögliche Dublette meldet.

- **Zusammenführen** (empfohlener Weg, Recht `personen_zusammenfuehrung:ÄNDERN`): Der Landesverband wählt die
  führende Person-Zeile. Mitgliedschaften, Graduierungen, Lizenzen, Zugriffe (4.4), Prüfungsteilnahmen und
  Benutzer-Verknüpfung der Dublette wandern dorthin. Konflikte (z. B. dieselbe Graduierung zweimal, zwei Judopässe,
  zwei Benutzerkonten, verschiedene Heimatvereine) zeigt der Server vorher an; der Landesverband entscheidet je Konflikt.
  Die Dublette wird danach gelöscht und verweist auf die führende Person (`personen.zusammengefuehrt_in`),
  damit Apps im Abgleich ihre Verweise umstellen können.
- **Löschen** (Recht `mitglieder:LÖSCHEN` im Verbandskontext): für Dubletten ohne eigene Daten oder fehlerhaft angelegte
  Mitglieder. Soft Delete (`geloescht_am`), danach Datenschutz-Bereinigung wie üblich. Hat die Zeile Graduierungen
  (außer dem automatischen 9. Kyu), Lizenzen, Modulergebnisse, Lehrgangsnachweise, offene Forderungen, aktive Mandate,
  einen offenen Transfer, einen Benutzer oder Zugriffe (4.4), verlangt der Server stattdessen das Zusammenführen.

Beides wird mit Grund im `audit_log` protokolliert und den betroffenen Vereinen angezeigt.

```sql
alter table personen add column zusammengefuehrt_in uuid references personen,
  add constraint nicht_in_sich_selbst check (zusammengefuehrt_in <> id);
-- Ziel muss existieren, nicht gelöscht und nicht selbst zusammengeführt sein; Ketten werden beim Zusammenführen
-- auf das Endziel umgeschrieben. Eindeutige Werte der Dublette (djb_id, benutzer_id) werden vor dem Umhängen geleert.
-- Weitere Konflikte: zwei Mitgliedschaften im selben Verein (eine bleibt, Mitgliedsnr. der älteren),
-- dasselbe Modul oder dieselbe Graduierung zweimal (ältere bleibt), doppelte Zugriffe (einer bleibt).
```

Konfliktregeln je Tabelle mit `person_id` (Vorschlag, der Landesverband kann je Fall abweichen):

| Tabelle | Konflikt | Regel |
|---|---|---|
| `lizenzen` (Judopass) | zwei wirksame Pässe | der ältere bleibt, der andere wird widerrufen (Sperrliste) |
| `passmarken_einsaetze` | Marken für beide Pässe im selben Jahr | Marke des widerrufenen Passes wird storniert (Gutschrift) |
| `judopass_antraege`, `transfers` | offene Vorgänge bei beiden | Zusammenführen erst nach Abschluss oder Rückzug |
| `pruefung_teilnehmer`, `lehrgang_anmeldungen`, `turnier_meldungen`, `mannschaft_mitglieder` | gleiche Prüfung, gleicher Lehrgang, gleiches Turnier, gleiche Mannschaft | ältere Zeile bleibt, die andere wird abgemeldet |
| `lehrgang_nachweise` | Nachweis an der Dublette | widerrufen und für die führende Person neu ausgestellt (Signatur) |
| `abrechnungspositionen` | Forderungen der Dublette | werden umgehängt, Beträge bleiben |
| `bankkonten`, `sepa_mandate` | gleiches Konto zweimal | ein Konto bleibt, Mandate werden darauf umgehängt |

### 4.3 Benutzer und Vereinszugehörigkeit

`benutzer` bleibt (Passwort, PIN, TOTP, Sperren, `ist_super_admin`).

Ein Benutzer kann in einem Verein **mehrere Rollen** haben (E97), z. B. Trainer und Kassierer; die Rechte addieren
sich (ODER über Quellen, 11.2).

```sql
alter table benutzer_vereine drop column rolle;           -- ersetzt durch benutzer_vereinsrollen
alter table benutzer_vereine drop column mitglied_id;      -- Verknüpfung läuft über personen.benutzer_id
-- benutzer.heimatverein_id (Migration 002) entfällt: der Heimatverein steht an der Person (4.1a)
create table benutzer_vereinsrollen (
  id uuid primary key,
  benutzer_verein_id uuid not null references benutzer_vereine,
  rolle_id   uuid not null references rollen on delete restrict,   -- nur ebene 'verein', global oder dieses Vereins
  gueltig_von date, gueltig_bis date,
  vergeben_von uuid references benutzer,
  widerrufen_am timestamptz,
  check (gueltig_bis is null or gueltig_bis >= gueltig_von)
);
create unique index vereinsrolle_aktiv on benutzer_vereinsrollen (benutzer_verein_id, rolle_id)
  where widerrufen_am is null;
```

Der Freigabe-Workflow (`angefragt` → `freigegeben`) bleibt. Berechtigungen aus einer Vereinszugehörigkeit wirken nur,
wenn sie `freigegeben` ist.

**Austritt** (E99): Endet die letzte Mitgliedschaft der verknüpften Person in einem Verein (Austritt oder
Vereinswechsel), setzt der Server die Zugehörigkeit in `benutzer_vereine` auf `gesperrt`, die Vereinsrollen und
vereinsbezogenen Direktrechte erhalten `gueltig_bis` = Austrittsdatum. Ausnahme: Funktionäre ohne eigene
Mitgliedschaft (Benutzer ohne verknüpfte Person in diesem Verein) sind nicht betroffen; sie entzieht der Admin.

### 4.4 Zugriff auf die eigenen Daten: Person selbst, Eltern, weitere Personen

Auf die Daten einer Person (Stammdaten, Kontakt, Graduierungen, Lizenzen inkl. Judopass) dürfen **mehrere Benutzer
gleichzeitig** zugreifen:

- die **Person selbst**, sobald sie einen eigenen Benutzer hat (`personen.benutzer_id`) – z. B. das Kind ab 14 mit eigenem Handy;
- jede Person mit einem **Zugriff** auf sie (Eltern, Vormund, weitere Bevollmächtigte), beliebig viele.

Beides gilt **nebeneinander**: Bekommt das Kind ein eigenes Konto, behalten die Eltern ihren Zugriff.
Ein Elternteil kann beliebig viele Kinder verantworten. Ersetzt `erziehungsberechtigte`; funktioniert auch, wenn die
Kinder in verschiedenen Vereinen sind.

```sql
create table personen_zugriffe (
  id                  uuid primary key,
  berechtigte_person_id uuid not null references personen,   -- wer zugreift (mit Benutzer verknüpft)
  betroffene_person_id  uuid not null references personen,   -- auf wessen Daten
  art         text not null check (art in ('erziehungsberechtigt','vormund','bevollmaechtigt')),
  umfang      text not null default 'aendern' check (umfang in ('lesen','aendern')),
  gueltig_von date, gueltig_bis date,                         -- leer = unbefristet, endet NICHT automatisch
  erteilt_von uuid references benutzer,
  volljaehrig_bestaetigt_am timestamptz,                      -- Zeitpunkt der letzten Freischaltung (Protokoll)
  freigeschaltet_bis date,                                    -- ab 18: Zugriff wirkt nur bis zu diesem Tag (je ein Jahr)
  widerrufen_am timestamptz,
  nachweis_dokument_id uuid references dokumente,             -- Vormund/Betreuung: Bestellungsurkunde
  check (berechtigte_person_id <> betroffene_person_id),
  check (gueltig_bis is null or gueltig_bis >= gueltig_von)
);
-- Serverprüfung (E103): betroffene Person hat ein Geburtsdatum; berechtigte Person ist volljährig und hat einen Benutzer
create unique index personen_zugriff_aktiv on personen_zugriffe (berechtigte_person_id, betroffene_person_id)
  where widerrufen_am is null;                                -- nach Widerruf neu erteilbar
```

**Eigener Zugang ab 14:** Ein Kind kann ab 14 Jahren einen eigenen Benutzer bekommen (Anlage durch Eltern, Heimatverein
oder ein Vereins-Admin mit `benutzer:ANLEGEN`). Es sieht dann seine Daten und seinen Judopass und darf seine Kontaktdaten ändern.
`personen.benutzer_id` darf nur gesetzt werden, wenn die Person ein Geburtsdatum hat und mindestens 14 ist (E103).

**Volljährigkeit:** Mit 18 **ruht** jeder Zugriff automatisch, gleich welcher Art. Ausnahme: `vormund` mit
hinterlegtem Nachweis (Betreuung eines volljährigen Menschen) ruht nicht. Bei der nächsten Anmeldung fragt der Server
die Person, ob sie den Zugriff für **ein weiteres Jahr** freischaltet; die Freischaltung muss jährlich erneuert werden
(`freigeschaltet_bis`). Hat die Person kein eigenes Konto, bleibt der Zugriff ruhend, bis sie eines hat. Sie kann jeden
Zugriff jederzeit beenden. Ein ruhender Zugriff gibt weder Lese- noch Änderungsrechte. Ohne Geburtsdatum der
betroffenen Person kann kein Zugriff erteilt werden.

**Wer darf Zugriffe erteilen und entziehen:** der Heimatverein der betroffenen Person (Admin, jeder Umfang), ein
Erziehungsberechtigter mit nicht ruhendem Zugriff (`art = 'erziehungsberechtigt'`) für sein Kind (Dritten nur
**Lesezugriff**, z. B. Großeltern, E86), die betroffene Person selbst ab Volljährigkeit. Der andere
Erziehungsberechtigte wird benachrichtigt.

**Umfang** (kein Recht aus 5.1, sondern eine feste Regel des Servers: gilt für die eigene Person und alle Personen
mit Zugriff, unabhängig vom Kontext):

| Daten | `lesen` | `aendern` |
|---|:-:|:-:|
| Stammdaten (Name, Geburtsdatum, Nationalität, Passfoto) | ✔ | – (ändert der Verein, bei Judopass-Inhabern nur per Antrag, 6.1) |
| Kontaktdaten | ✔ | ✔ |
| Graduierungen | ✔ | – |
| Lizenzen inkl. **Judopass mit Aztec-Code** und Wettkampflizenz | ✔ | – |
| Mitgliedschaften (Vereine, Status) | ✔ | – |

---

## 5. Rechte, Operationen, Rollen

### 5.1 Rechte und Operationen

```sql
create table rechte (                       -- besteht, wird erweitert
  id uuid primary key, schluessel text unique not null, name text not null,
  anwendung text, beschreibung text
);
create table rechte_operationen (           -- welche Operationen ein Recht kennt
  recht_id  uuid references rechte,
  operation text check (operation in ('LESEN','AENDERN','LOESCHEN','ANLEGEN','DELEGIEREN')),
  primary key (recht_id, operation)
);
```

Eine Operation, die ein Recht nicht kennt (z. B. `ueberweisung:LOESCHEN`), kann nirgends vergeben werden.
„Schreiben“ ist keine Operation, sondern in der Oberfläche die Kurzform für ANLEGEN + ÄNDERN.

### 5.2 Rollen

```sql
create table rollen (
  id          uuid primary key,
  schluessel  text not null,
  name        text not null,
  ebene       text not null check (ebene in ('verein','verband')),  -- wo die Rolle vergeben werden darf
  verein_id   uuid references vereine,       -- NULL = globale Rolle; sonst vereinseigene Rolle
  ist_system  boolean not null default false, -- Seed-Rollen, nicht löschbar
  unique nulls not distinct (verein_id, schluessel),
  check (ebene = 'verein' or verein_id is null)          -- Verbandsrollen sind immer global
);
-- Serverprüfung bei Vergabe: benutzer_vereinsrollen nur Rollen mit ebene 'verein' und verein_id leer oder = Verein;
-- benutzer_verbandsrollen nur Rollen mit ebene 'verband'. Rollen werden immer über rolle_id aufgelöst, nie über den Schlüssel.
create table rollen_berechtigungen (
  rolle_id       uuid references rollen on delete cascade,
  recht_id       uuid, operation text,
  datenfilter_id uuid references datenfilter,
  foreign key (recht_id, operation) references rechte_operationen,
  primary key (rolle_id, recht_id, operation)
);
create table benutzer_verbandsrollen (       -- Rollen auf Verbandsebene (neben benutzer_vereine)
  id uuid primary key,
  benutzer_id uuid not null references benutzer,
  rolle_id    uuid not null references rollen,          -- nur Rollen mit ebene = 'verband'
  verband_id  uuid not null references verbaende,
  gueltig_von date, gueltig_bis date,
  vergeben_von uuid references benutzer,
  widerrufen_am timestamptz,
  check (gueltig_bis is null or gueltig_bis >= gueltig_von)
);
create unique index verbandsrolle_aktiv on benutzer_verbandsrollen (benutzer_id, rolle_id, verband_id)
  where widerrufen_am is null;
```

**Vereinseigene Rollen** (E98): Der Vereins-Admin legt sie an und ändert sie (Recht `rolle:ANLEGEN/ÄNDERN/LÖSCHEN`
im Vereinskontext); sie sind nur im eigenen Verein sichtbar und vergebbar. Erlaubt sind nur Rechte aus der
**Positivliste der Vereinsebene** (`rechte.vereinsrolle_erlaubt`) und höchstens Operationen, die der Anlegende selbst
delegieren darf. Nicht auf der Liste stehen u. a. `transfer`, `lizenz`, `judopass_antrag`, `rolle`. Eine vereinseigene
Rolle darf keinen Schlüssel einer globalen Rolle verwenden. Gelöscht werden kann sie nur, wenn sie nicht vergeben ist.

```sql
alter table rechte add column vereinsrolle_erlaubt boolean not null default false;
```

### 5.3 Direkte Berechtigungen und Delegation

```sql
-- ersetzt benutzer_rechte
create table benutzer_berechtigungen (
  id             uuid primary key,
  benutzer_id    uuid not null references benutzer,
  verein_id      uuid references vereine,
  verband_id     uuid references verbaende,
  recht_id       uuid not null, operation text not null,
  datenfilter_id uuid references datenfilter,
  attribute      jsonb not null default '{}',
  gueltig_von date, gueltig_bis date,
  vergeben_von   uuid references benutzer,
  delegiert_aus_quelle text check (delegiert_aus_quelle in ('rolle','lizenz','direkt')),
  delegiert_aus_id     uuid,
  check ((delegiert_aus_quelle is null) = (delegiert_aus_id is null)),
  foreign key (recht_id, operation) references rechte_operationen,
  check (num_nonnulls(verein_id, verband_id) = 1),
  vergeben_durch_super_admin boolean not null default false,   -- setzt nur der Server (Trigger aus vergeben_von)
  constraint keine_weiterdelegation check (delegiert_aus_id is null or operation <> 'DELEGIEREN'),
  -- DELEGIEREN direkt (ohne Herkunft) vergibt nur der Super-Admin; jede andere Vergabe setzt delegiert_aus_*
  constraint delegieren_nur_super_admin check (operation <> 'DELEGIEREN' or vergeben_durch_super_admin),
  constraint delegation_befristet check (delegiert_aus_id is null or gueltig_bis is not null),
  check (gueltig_bis is null or gueltig_bis >= gueltig_von)
);
-- vergeben_durch_super_admin ist nicht über die API setzbar: ein Trigger leitet es aus benutzer(vergeben_von).ist_super_admin ab
```

**Delegationsregeln**

1. Wer `recht:DELEGIEREN` in einem Bereich hat, darf anderen Operationen dieses Rechts **in diesem Bereich oder darunter** geben.
   Aus einer Vereinsquelle entsteht nur eine Berechtigung mit `verein_id` = dieser Verein.
2. Der Datenfilter der Delegation darf nicht lockerer sein als der des Gebers. Geprüft wird je Filterspalte
   (Funktion `filter_enger_oder_gleich(a, b)`): Rangspannen und Wertspannen innerhalb der des Gebers, Feldgruppen und
   Felder Teilmenge, `nur_aktive` nicht von true auf false; leer bedeutet unbeschränkt. Hat der Geber einen Filter,
   braucht die Delegation einen.
3. **Nur eine Ebene:** Eine delegierte Berechtigung enthält nie `DELEGIEREN` (DB-Constraint). Wer etwas delegiert bekommen hat,
   kann es nicht weitergeben.
4. **Delegierte Rechte haben immer ein Enddatum** (E102, höchstens zwei Jahre, DB-Constraint `delegation_befristet`).
   Sie bleiben bis dahin bestehen, auch wenn der Geber sein DELEGIEREN verliert (Lizenz abgelaufen, Rolle entzogen).
   `delegiert_aus_*` dient der Nachvollziehbarkeit. Verliert der Geber sein DELEGIEREN, zeigt der Server die nun
   **verwaisten Delegationen** dem Admin der Ebene an (Vereins-Admin bzw. Landesverbands-Admin), der sie entziehen
   kann. Ein Entzug wegen Missbrauch kann die Delegationen des Gebers in einem Schritt mit entziehen.
5. Jede Vergabe und jeder Entzug wird im `audit_log` protokolliert.

---

## 6. Lizenzen

`lizenzen` bleibt die Tabelle für Lizenzen (bisher Judopass, Wettkampf-, Trainer-, Prüferlizenz, Erste Hilfe …).
Neu: ein Katalog der Lizenzarten, Berechtigungen je Lizenzart, Inhaber ist die Person, Geltungsbereich und Aussteller.

```sql
create table lizenzarten (                   -- ersetzt den CHECK auf lizenzen.art
  id uuid primary key, schluessel text unique not null, name text not null,
  geltung text not null check (geltung in ('bundesweit','verband')),
  ausstellende_ebenen text[] not null default '{}',   -- erlaubte Ebenen: dachverband, landesverband, bezirk, kreis, verein
  standard_laufzeit_monate int
);
create table lizenzart_berechtigungen (
  lizenzart_id   uuid references lizenzarten on delete cascade,
  recht_id       uuid, operation text,
  datenfilter_id uuid references datenfilter,
  foreign key (recht_id, operation) references rechte_operationen,
  primary key (lizenzart_id, recht_id, operation)
);

alter table lizenzen
  add column lizenzart_id               uuid not null references lizenzarten,  -- ersetzt "art"
  add column person_id                  uuid not null references personen,     -- Inhaber
  add column gilt_in_verband_id         uuid references verbaende,             -- Geltungsbereich bei geltung = 'verband'
  add column ausgestellt_von_verband_id uuid references verbaende,
  add column ausgestellt_von_verein_id  uuid references vereine,                 -- wenn ausstellende Ebene = verein
  add column widerrufen_am              timestamptz,
  add column fuer_verein_id             uuid references vereine,               -- Startrecht für diesen Verein (Wettkampflizenz)
  add column code_inhalt                text,                                    -- Judopass: Inhalt des Aztec-Codes
  add column passfoto_dokument_id       uuid references dokumente,               -- Judopass: aktuelles Passfoto
  add column gueltig_von                date;                                    -- leer = ab Ausstellung
alter table lizenzen drop constraint lizenzen_dokument_fk;  -- (verein_id, dokument_id) – muss vor dem Drop weg
alter table lizenzen drop column verein_id;                 -- mitglied_id → person_id; Lizenzen hängen nur an der Person

alter table dokumente
  add column person_id uuid references personen;          -- Inhaber; Nachweise und Passfotos gehören der Person
alter table dokumente alter column verein_id drop not null;  -- nur noch Ablageort/Hochlader, keine Eigentümerschaft
alter table lizenzarten
  add column braucht_verein boolean not null default false,  -- fuer_verein_id ist Pflicht (Wettkampflizenzen)
  add column hat_aztec_code    boolean not null default false;  -- Judopass
-- eindeutige Nummer: unique (lizenzart_id, nummer) where nummer is not null and geloescht_am is null
-- Serverprüfung je Lizenzart: geltung 'verband' → gilt_in_verband_id Pflicht; braucht_verein → fuer_verein_id Pflicht
alter table lizenzen
  add constraint lizenz_zeitraum check (gueltig_bis is null or gueltig_von is null or gueltig_bis >= gueltig_von),
  add constraint ein_aussteller check (num_nonnulls(ausgestellt_von_verband_id, ausgestellt_von_verein_id) <= 1);
alter table lizenzarten add column einmal_je_person boolean not null default false;   -- Judopass: true
-- Serverprüfung: bei einmal_je_person höchstens eine nicht widerrufene, nicht gelöschte Lizenz je Person
-- (geprüft beim Anlegen und erneut beim Genehmigen); Einzelstartrecht: höchstens eines je Person und Saison
```

**Gültigkeit:** Eine Lizenz wirkt, wenn `gueltig_von ≤ heute`, `gueltig_bis` leer oder `≥ heute`, nicht widerrufen,
nicht gelöscht und heute nicht ausgesetzt (`lizenz_aussetzungen`). Abgelaufene Lizenzen bleiben gespeichert (Historie, Ablaufwarnung).

**Judopass:** Lizenz mit Gültigkeitsdauer (`gueltig_bis`) und Nummer. Die bisherige Spalte `mitglieder.judopass_url` entfällt.

**Lizenzen und Dokumente gehören der Person.** Inhaber einer Lizenz ist immer die Person (`lizenzen.person_id`); ein
Vereinswechsel ändert daran nichts. Das gilt auch für Nachweise ohne Rechte wie Erste Hilfe und das polizeiliche
Führungszeugnis. Zugehörige Dokumente (Scan, Bescheinigung, Passfoto) tragen `dokumente.person_id`. Das **Passfoto**
gehört zum Judopass (`lizenzen.passfoto_dokument_id`); ein neues Foto kommt nur über einen genehmigten Antrag (6.1).
Sichtbar sind die Dokumente für die Person und Berechtigte (4.4). Vereine der Person sehen sie nach der Positivliste in
11.1 (Scans von Nachweisen nur der Verein, bei dem sie vorgelegt wurden; `dokumente.verein_id` = Ablageort); das
Passfoto zusätzlich für den Landesverband des Heimatvereins.

### 6.0 Judopass und Aztec-Code

Der **Aztec-Code** wird vom Stammdaten-Server **erzeugt**, und zwar bei **Erteilung**, bei **Verlängerung** und wenn der
**Landesverband** einen Antrag genehmigt oder die Daten direkt ändert (6.1, E36). Abschließende Liste der Auslöser:
Erteilung, Verlängerung, Änderung von Vorname, Nachname, Geburtsdatum, Nationalität oder Passfoto. Grad-, Vereins- oder
Heimatvereinswechsel lösen **keinen** neuen Code aus. Der Code enthält verschlüsselt:

| Inhalt | Quelle |
|---|---|
| Vorname, Nachname, Geburtsdatum | `personen` |
| Passfoto im Kleinformat | `lizenzen.passfoto_dokument_id` (Dokument der Person), stark verkleinert |
| *zusätzlich empfohlen:* Judopass-Nr., gültig bis, Ausstellungszeitpunkt, Schlüssel-ID | `lizenzen` |

```sql
alter table lizenzen
  add column code_erzeugt_am   timestamptz,
  add column code_schluessel_id uuid references signaturschluessel;   -- bzw. eigener Schlüssel für den Judopass
-- code_inhalt: der fertige verschlüsselte Inhalt (Base45/Base64), daraus wird das Aztec-Bild beim Anzeigen erzeugt
```

Technische Punkte:
- **Warum Aztec:** braucht keine Ruhezone, liest sich gut vom Handy-Display und bei Beschädigung (wie Bahn- und
  Bordkarten).
- **Größe:** Ein Aztec-Code fasst höchstens rund **1,9 KB** Binärdaten (bei 23 % Fehlerkorrektur), also weniger als ein
  QR-Code (2,9 KB). Abzüglich Name, Datum, Nummer, Signatur (64 Byte) und Verschlüsselungs-Overhead bleiben für das
  Passfoto etwa **1,2–1,5 KB**: ca. 48 × 64 Pixel, Graustufen, WebP/AVIF. Die Base64-Kodierung kostet ein Drittel mehr –
  deshalb im Binärmodus kodieren. Das muss früh mit echten Fotos und der JudoPass-App ausprobiert werden.
- **Echtheit:** Verschlüsselung allein verhindert keine Fälschung. Empfehlung: Inhalt **signieren** (Ed25519, wie die
  Tokens) **und** verschlüsseln. Die Schlüssel-ID im Inhalt erlaubt Schlüsselrotation; alte Pässe bleiben lesbar.
- **Auslesen** erfolgt mit einer **JudoPass-App**. Sie ist eine registrierte Anwendung (`anwendungen`) und enthält den
  Entschlüsselungsschlüssel und den öffentlichen Prüfschlüssel, damit sie offline prüfen kann. Ein in einer App
  ausgelieferter Schlüssel lässt sich extrahieren; die Verschlüsselung schützt deshalb nur vor zufälligem Mitlesen.
  Vor Fälschung schützt allein die **Signatur** – sie ist darum Pflicht, nicht optional.
- Ein neuer Aztec-Code ersetzt den alten. Der Ausstellungszeitpunkt steht verpflichtend im Code. Die JudoPass-App
  gleicht regelmäßig eine **Sperrliste** ab (Pass-Nr. + Ausstellungszeitpunkt): ersetzte Codes, widerrufene und
  ausgesetzte Pässe. Ein Code gilt offline nur, wenn er nicht auf der Liste steht. Quelle der Liste ist die Tabelle
  `judopass_codes` (unten); der alte Ausstellungszeitpunkt geht beim Ersetzen nicht verloren.
- **Datenschutz:** Weil der Entschlüsselungsschlüssel in der App liegt, gelten Geburtsdatum und Foto im Code als
  faktisch lesbar. Vor dem Betrieb ist eine Datenschutz-Folgenabschätzung für den Code-Inhalt nötig.

```sql
create table judopass_codes (                -- Historie aller erzeugten Codes, Quelle der Sperrliste
  id uuid primary key,
  lizenz_id uuid not null references lizenzen,
  ausgestellt_am timestamptz not null,
  ersetzt_am timestamptz,                    -- gesetzt, sobald ein neuer Code erzeugt wird
  schluessel_id uuid references signaturschluessel
);
```

Die Person selbst und alle Personen mit Zugriff (4.4) sehen den Judopass inkl. Aztec-Code, z. B. auf dem Handy des Kindes
und der Eltern gleichzeitig.

### 6.1 Judopass-Anträge an den Landesverband (Erteilung und Änderung)

Vorname, Nachname, Geburtsdatum, Nationalität und Passfoto von Judopass-Inhabern ändert kein Verein direkt.
Der Verein stellt einen **Antrag**, der Landesverband entscheidet. Bei Personen **ohne** Judopass ändert der Verein
diese Daten direkt (Heimatverein, siehe 4.1).

Der **Landesverband** kann die Daten von Judopass-Inhabern weiterhin **direkt** ändern (Ausnahmefall, z. B.
Korrektur nach Rückfrage). Auch dabei entsteht ein neuer Aztec-Code; die Änderung wird mit Grund im `audit_log`
protokolliert. Der Regelweg ist der Antrag.

```sql
create table judopass_antraege (            -- Erteilung, Datenänderung, Verlängerung
  -- an_verband_id wird vom Server aus dem Heimatverein abgeleitet, nicht frei gesetzt; beim Transfer umgehängt
  id               uuid primary key,
  art              text not null check (art in ('erteilung','aenderung','verlaengerung')),
  person_id        uuid not null references personen,
  lizenz_id        uuid references lizenzen,                 -- betroffener Judopass (bei 'erteilung' leer bis Genehmigung)
  gestellt_von_verein_id uuid not null references vereine,   -- Heimatverein
  an_verband_id    uuid not null references verbaende,       -- zuständiger Landesverband
  aenderungen      jsonb not null default '{}',                           -- {"nachname": {"alt": "…", "neu": "…"}, …}; nur erlaubte Felder
  foto_dokument_id uuid references dokumente,                -- neues Passfoto, falls beantragt
  begruendung      text,                                     -- z. B. „Heirat“, „neues Foto“
  status           text not null default 'offen'
                   check (status in ('offen','genehmigt','abgelehnt','zurueckgezogen')),
  gestellt_von     uuid not null references benutzer, gestellt_am timestamptz not null default now(),
  entschieden_von  uuid references benutzer, entschieden_am timestamptz,
  ablehnungsgrund  text,
  passfoto_alt_dokument_id uuid references dokumente,       -- Foto zum Zeitpunkt des Antrags (Prüfung wie alt-Werte)
  jahr int,                                                  -- bei 'verlaengerung': Jahr der Marke, gueltig_bis = 31.12.jahr
  check (art in ('erteilung','verlaengerung') or aenderungen ?| array['vorname','nachname','geburtsdatum','nationalitaet']
         or foto_dokument_id is not null),
  check (aenderungen - array['vorname','nachname','geburtsdatum','nationalitaet'] = '{}'::jsonb),   -- nur erlaubte Felder
  check ((art = 'verlaengerung') = (jahr is not null))
);
create unique index ein_offener_judopass_antrag on judopass_antraege (person_id, art)
  where status = 'offen';      -- je Person und Art höchstens ein offener Antrag
-- Serverprüfung bei Erteilung (Anlegen und Genehmigen): kein wirksamer Judopass vorhanden
```

**Erst-Erteilung** läuft ebenfalls als Antrag (`art = 'erteilung'`): Der Verein beantragt den Judopass mit
Passfoto; der Landesverband prüft Personendaten und Foto. Bei Genehmigung legt der Server die Lizenz an
(Judopass-Nr., `gueltig_bis` = 31.12. des laufenden Jahres), erzeugt den Aztec-Code und bucht die Jahressichtmarke für
das laufende Jahr (6.2).

Ablauf:
1. Der **Heimatverein** stellt den Antrag (Recht `judopass_antrag:ANLEGEN`, Vereins-Admin). Er darf ihn bis zur Entscheidung zurückziehen.
2. Der Antrag erscheint in der **Eingangsbox des Landesverbands** (Liste offener Anträge im Verbandskontext,
   Recht `judopass_antrag:LESEN/ÄNDERN`).
3. Der Landesverband **genehmigt** oder **lehnt ab** (mit Grund). Teilgenehmigung gibt es nicht.
4. **Bei Genehmigung**, in einer Transaktion: Personendaten bzw. Passfoto werden geändert und der Server erzeugt einen
   **neuen Aztec-Code**. Der Verein sieht das Ergebnis.
5. Prüfung beim Genehmigen: Die `alt`-Werte und `passfoto_alt_dokument_id` müssen noch dem aktuellen Stand entsprechen,
   sonst muss neu beantragt werden (keine verlorenen Änderungen).

Die Eingangsbox ist eine gefilterte Sicht: offene Anträge mit `an_verband_id` = aktiver Verbandskontext.

### 6.2 Verlängerung des Judopasses: digitale Jahressichtmarke

Die Verlängerung ist an die **Jahressichtmarke** gekoppelt (bisher zum Einkleben, vom Verein beim Landesverband
gekauft). Digital wird daraus eine Marke **je Pass und Jahr**.

**Verlängern:** Der **Heimatverein beantragt** die Verlängerung gegen Zahlung der Jahressichtmarke – einzeln oder als
**Sammelantrag** („alle Personen, deren Heimatverein wir sind und die einen Judopass haben, für 2027“), als
`judopass_antraege` mit `art = 'verlaengerung'` und `jahr`. Der Sammelantrag wählt nach Heimatverein, nicht nach
Mitgliedschaftsstatus; der Verein kann einzelne Personen abwählen. Beantragt werden kann nur das laufende oder das
folgende Jahr. Der **Landesverband gibt frei**. Erst mit der Freigabe entsteht ein **Marken-Einsatz**: `gueltig_bis`
wird auf den 31.12. von `jahr` gesetzt (nie verkürzt), ein neuer Aztec-Code erzeugt und die Jahressichtmarke berechnet.

**Bezahlen – einmal im Jahr je Pass:** Eine Jahressichtmarke wird **genau einmal je Pass und Jahr** berechnet, und zwar

- bei der **Neuanlage** eines Passes (Erteilung, 6.1) für das laufende Jahr, oder
- bei der **Verlängerung** für das beantragte Jahr (typisch die Sammelverlängerung zu Jahresbeginn).

Die Abrechnung regelt [entwurf-finanzen.md](entwurf-finanzen.md) (6.3). **Storno** einer Marke (nur Landesverband)
erzeugt eine Gutschrift, setzt `gueltig_bis` auf den Stand davor zurück und erzeugt einen neuen Aztec-Code (der alte
kommt auf die Sperrliste).

```sql
create table passmarken_einsaetze (
  id uuid primary key,
  lizenz_id  uuid not null references lizenzen,       -- der Judopass
  verein_id  uuid not null references vereine,        -- Heimatverein, zahlt
  antrag_id  uuid references judopass_antraege,       -- Verlängerungs- bzw. Erteilungsantrag
  verband_id uuid not null references verbaende,      -- Landesverband des Heimatvereins, rechnet ab
  jahr       int not null,
  anlass     text not null check (anlass in ('neuanlage','verlaengerung')),
  eingesetzt_am timestamptz not null default now(), eingesetzt_von uuid references benutzer,
  storniert_am timestamptz,                           -- Fehlbuchung, nur durch Landesverband
  storno_grund text
);
create unique index passmarke_je_jahr
  on passmarken_einsaetze (lizenz_id, jahr) where storniert_am is null;   -- Storno gibt das Jahr wieder frei
```

**Judopass beim Wechsel in einen anderen Landesverband:** Der Pass **bleibt** gültig, mit Nummer und Ablaufdatum; er
wird nicht neu ausgestellt. Die **nächste Verlängerung** beantragt der neue Heimatverein, abgerechnet über dessen
Landesverband. Anträge auf Datenänderung gehen ab dem Wechsel an den neuen Landesverband.

Vorteile gegenüber Papiermarken: kein Versand, kein Verlust, keine Doppelverwendung (DB-Constraint), der Pass ist
sofort gültig, der Landesverband hat jederzeit eine genaue Abrechnungsgrundlage. Der Verein kann die Kosten über
Dojo Master Pro (Beitragsabrechnung) an die Mitglieder weitergeben.

### 6.3 Abrechnung, Rechnungslauf, Bankkonten und SEPA-Mandate

Ausgelagert nach [entwurf-finanzen.md](entwurf-finanzen.md) (Abschnitte 6.3, 6.3a, 6.5 mit gleicher Nummer).

### 6.4 Wettkampflizenzen

**Wettkampflizenz** gibt es in zwei Arten, beide mit Startrecht für einen bestimmten Verein (`fuer_verein_id`):

| Lizenzart | Startrecht für | Typisch |
|---|---|---|
| `wettkampf_einzel` (Einzelstartrecht) | einen Verein | der Heimatverein |
| `wettkampf_mannschaft` (Mannschaftsstartrecht) | einen Verein | oft ein anderer Verein (Startgemeinschaft, Ligamannschaft) |

Wettkampflizenzen stellt der **DJB** aus, den Judopass der **Landesverband**.

Startrechte gelten je **Saison** (`lizenzen.saison`). Ein Mannschaftsstartrecht kann während der Saison **geändert**
(z. B. anderer Verein; Historie bleibt über `audit_log` erhalten) und für eine bestimmte Dauer **ausgesetzt** werden:

```sql
alter table lizenzen add column saison text;          -- z. B. '2026/27' oder '2027'
create table lizenz_aussetzungen (
  id uuid primary key,
  lizenz_id uuid not null references lizenzen,
  von date not null, bis date,                        -- bis leer = bis auf Weiteres
  grund text, ausgesetzt_von uuid references benutzer,
  check (bis is null or bis >= von),
  exclude using gist (lizenz_id with =, daterange(von, coalesce(bis, 'infinity'), '[]') with &&)   -- keine Überlappung
);
alter table lizenzarten add column aussetzbar boolean not null default false;   -- Mannschaftsstartrecht, Judopass: true
-- Aussetzen: Recht lizenz_aussetzung:ANLEGEN/ÄNDERN beim Aussteller der Lizenzart (Judopass: Landesverband, Startrechte: DJB)
```

Ändert der DJB während der Saison den Verein eines Mannschaftsstartrechts, legt der Server eine **neue Lizenzzeile**
an und widerruft die alte (keine Änderung in place); Mannschaftsmitgliedschaften mit der alten Lizenz enden damit.

Geprüft wird bei jeder Turniermeldung (9b.5): Für Einzelwettkämpfe gültiges Einzelstartrecht für den meldenden Verein,
für Mannschaftswettkämpfe gültiges Mannschaftsstartrecht für den Verein der Mannschaft – jeweils am Turniertag.

### 6.6 Lizenzarten, Ausstellen und Wirkung als Rechte

**Wirkung als Rechte** (E104): Die Berechtigungen einer Lizenz wirken für den Benutzer, der mit der Inhaber-Person
verknüpft ist, im Geltungsbereich der Lizenz – **im Verbandskontext** dieses Bereichs und **im Vereinskontext jedes
Vereins im Bereich**, in dem der Benutzer freigegeben ist (z. B. Kyu-Prüfer im eigenen Verein):
- `geltung = 'bundesweit'`: Bereich = DJB (derzeit keine rechtegewährende Lizenzart; Trainer A–C sind reine Nachweise).
- `geltung = 'verband'` (z. B. Prüferlizenzen): Bereich = `gilt_in_verband_id` samt Teilbaum.

**Ausstellen:**
- Prüferlizenzen (Kyu-Prüfer, Kreis-Dan-Vorsitzender, Dan-Prüfer, Dan-Prüfungsbeauftragter) stellt der **Landesverband** aus.
- Trainerlizenzen A, B, C stellen **DJB oder Landesverband** aus.
- Judopass stellt der **Landesverband** aus, Wettkampflizenzen der **DJB**.
- Der Aussteller braucht `lizenz:ANLEGEN` im ausstellenden Verband; dessen Ebene muss in `lizenzarten.ausstellende_ebenen` stehen.
- `gilt_in_verband_id` muss im Teilbaum des ausstellenden Verbands liegen (Beispiel: Landesverband stellt Kreis-Lizenz für einen eigenen Kreis aus).

**Lizenzarten** (Auszug):

| Lizenzart | Geltung | Aussteller | Gewährt Berechtigungen |
|---|---|---|---|
| Judopass (mit Aztec-Code) | – | Landesverband | nein (Nachweis) |
| Wettkampflizenz Einzelstartrecht | – (für einen Verein, je Saison) | DJB | nein (Startrecht) |
| Wettkampflizenz Mannschaftsstartrecht | – (für einen Verein, je Saison; änderbar, aussetzbar) | DJB | nein (Startrecht) |
| Erste Hilfe, Ehrenkodex | – | – | nein (Nachweis) |
| Polizeiliches (erweitertes) Führungszeugnis | – | – (Einsicht durch den Verein) | nein (Nachweis) |
| Trainer A, B, C | bundesweit | DJB oder Landesverband | nein (Nachweis) |
| Kyu-Prüfer | verband | Landesverband | ja |
| Kreis-Dan-Vorsitzender | verband (Kreis) | Landesverband | ja |
| Dan-Prüfer | verband | Landesverband | ja |
| Dan-Prüfungsbeauftragter | verband | Landesverband | ja |

### 6.7 Führungszeugnis

Das Führungszeugnis wird als **Lizenz** an der Person geführt (E84). Wegen § 72a SGB VIII gelten Sonderregeln:
- Gespeichert wird nur die **Einsichtnahme** (wer, wann, Ausstellungsdatum, Ergebnis); das Dokument selbst nicht.
- **Je einsehendem Verein eine Lizenzzeile** (`eingesehen_von_verein_id` Pflicht); so endet die Tätigkeit je Verein
  getrennt.
- **Löschfrist:** drei Monate nach Ende der Tätigkeit (`loeschen_ab`), ein täglicher Lauf löscht endgültig (Hard Delete
  mit inhaltslosem Löschhinweis für den Abgleich). Endet die Mitgliedschaft oder die letzte Rolle im einsehenden
  Verein, setzt der Server `taetigkeit_beendet_am`; sonst erinnert er den Verein jährlich.
- Die Lizenzart ist vom **Abgleich ausgenommen** (keine Verteilung an Apps, nur Live-Abfrage mit Scope `mitglieder:efz`).
- Andere Vereine sehen nur „liegt vor, gültig bis“ (11.1); `einschlaegig_verurteilt` sieht nur der einsehende Verein.

```sql
alter table lizenzen
  add column einschlaegig_verurteilt boolean,          -- nur bei Lizenzart Führungszeugnis
  add column eingesehen_von_verein_id uuid references vereine,
  add column taetigkeit_beendet_am date,
  add column loeschen_ab date;                         -- taetigkeit_beendet_am + 3 Monate
alter table lizenzarten add column im_abgleich boolean not null default true;   -- Führungszeugnis: false
-- unique (person_id, lizenzart_id, eingesehen_von_verein_id) für das Führungszeugnis
```

Die bisherige Tabelle `fuehrungszeugnis_einsichten` geht darin auf.

---

## 7. Datenfilter

Ein Datenfilter schränkt eine Berechtigung ein. Filter sind **wiederverwendbare** Zeilen (eindeutiger `schluessel`);
mehrere Berechtigungszeilen (`rollen_berechtigungen`, `lizenzart_berechtigungen`, `benutzer_berechtigungen`) können
denselben Filter nutzen. Kein freies jsonb, nur feste Spalten.

```sql
create table datenfilter (
  id uuid primary key, schluessel text unique not null, name text not null,
  -- Subjektfilter: welche Personen
  subjekt_min_rang      smallint,
  subjekt_max_rang      smallint,
  subjekt_lizenzart_id  uuid references lizenzarten,   -- Person muss diese Lizenz haben (z. B. Judopass)
  nur_aktive            boolean not null default true,   -- aktiv = Mitgliedschaft im Bereich mit status 'aktiv';
                                                         -- Seed-Filter für transfer, zusammenführen, löschen,
                                                         -- judopass_antrag, kontakt und Prüfungsteilnehmer: false
  -- Wertfilter: welcher Grad darf eingetragen/geprüft werden
  wert_art              text check (wert_art in ('kyu','dan')),
  wert_stufe_von        smallint,
  wert_stufe_bis        smallint,
  wert_bis_eigener_grad boolean not null default false,
  -- Feldfilter: welche Feldgruppen/Felder
  feldgruppen           text[],                          -- z. B. {kern,sport}
  felder                text[]                           -- z. B. {vorname,nachname,geburtsdatum,nationalitaet}
);
```

**Gürtelrang** (`grad_rang(art, stufe)`): 9. Kyu = 1 … 1. Kyu = 9, 1. Dan = 10 … 10. Dan = 19. Jede Person erhält beim Anlegen automatisch den **9. Kyu** (Rang 1, ohne Prüfung und Gebühr, E76). Dieser automatische Grad zählt nicht als Sperre beim Löschen (4.2a).
Maßgeblich für den Subjektfilter ist der aktuelle Grad der Person (View `person_aktueller_grad`).
Personen ohne Graduierung erfüllen keinen Filter mit Mindestrang.

**Wertfilter** gilt für den Grad, der vergeben bzw. geprüft wird (`pruefung_teilnehmer.angestrebt_*`,
`graduierungen.art/stufe`). Bei ÄNDERN wird der **alte und der neue** Wert geprüft.
Bei LÖSCHEN wird der alte Wert geprüft.
`wert_bis_eigener_grad`: Obergrenze ist der aktuelle Grad des handelnden Benutzers zum Zeitpunkt der Aktion. Hat der
Benutzer keine verknüpfte Person oder keinen Grad, ist der Filter nicht erfüllt.

**Aktueller Grad** = höchster Rang der nicht gelöschten Graduierungen (auch bei Nacherfassung mit Lücken). Die
Wartezeit zählt ab der höchsten Graduierung unterhalb des Zielgrades.

**Feldfilter:** Nicht erlaubte Felder fehlen beim Lesen im JSON; beim Schreiben wird ein Request mit nicht erlaubten
Feldern abgelehnt (nicht stillschweigend ignoriert).

---

## 8. Graduierungen

Die Tabelle `graduierungen` speichert die Gürtel: `art` (kyu/dan), `stufe`, `datum`, `urkunden_nr` (z. B. „KYU-13230“),
`pruefer`, `ort`, `quelle`. Die Gürtelfarbe erzeugt die API. Änderung: Bezug auf die Person statt auf die Mitgliedschaft.

```sql
alter table graduierungen
  add column person_id   uuid not null references personen,  -- statt (verein_id, mitglied_id)
  add column pruefung_id uuid references pruefungen,
  alter column verein_id drop not null;                      -- nur noch: in welchem Verein abgelegt
-- unique (person_id, art, stufe) where geloescht_am is null (partiell, wegen Soft Delete und Zusammenführen)
-- quelle: 'pruefung','import','nacherfassung' (bisheriges 'manuell' → 'nacherfassung'; einheitlich mit modul_ergebnisse)
```

Graduierungen entstehen regulär durch den **Abschluss einer Prüfung**, und zwar erst dann, wenn damit **alle Module**
des Grades bestanden sind (8.1). Direktes Anlegen (Nacherfassung alter Urkunden, Import) bleibt Admin und Import vorbehalten.

### 8.1 Module zur nächsten Graduierung

Der Weg zum nächsten Grad besteht aus **Modulen** (laut Prüfungsordnung, z. B. Stand, Boden, Kata, Theorie).
Module können in **verschiedenen Prüfungen** abgelegt werden; der nächste Gürtel wird erst vergeben, wenn alle
Pflichtmodule des Grades bestanden sind.

```sql
create table pruefungsordnungen (            -- Version der Prüfungsordnung (DJB-weit)
  id uuid primary key, name text not null,          -- z. B. „DJB-Kyu-Prüfungsordnung 2025“
  art text not null check (art in ('kyu','dan')),
  gueltig_ab date not null, gueltig_bis date,
  exclude using gist (art with =, daterange(gueltig_ab, coalesce(gueltig_bis, 'infinity'), '[]') with &&)
);                                            -- je Art gilt an jedem Tag höchstens eine Ordnung
create table module (                        -- Katalog: welche Module gehören zu welchem Grad
  id uuid primary key,
  pruefungsordnung_id uuid not null references pruefungsordnungen,
  ziel_art   text not null check (ziel_art in ('kyu','dan')),
  ziel_stufe smallint not null,                      -- Grad, zu dem das Modul führt
  schluessel text not null, name text not null,
  pflicht    boolean not null default true,
  sortierung int not null default 100,
  unique (pruefungsordnung_id, ziel_art, ziel_stufe, schluessel)
);
create table modul_ergebnisse (              -- bestandene Module je Person (Historie)
  id uuid primary key,
  person_id   uuid not null references personen,
  modul_id    uuid not null references module,
  bestanden_am date not null,
  pruefung_id uuid references pruefungen,
  abgenommen_von uuid references benutzer,
  quelle text not null default 'pruefung' check (quelle in ('pruefung','import','nacherfassung')),
  geloescht_am timestamptz
);
create unique index modul_einmal on modul_ergebnisse (person_id, modul_id)
  where geloescht_am is null;                          -- ein Modul wird nur einmal bestanden
```

**Wer Module abnimmt** – dieselben Lizenzen und Wertfilter wie bei Graduierungen, bezogen auf den **Zielgrad des Moduls**:

| Zielgrad des Moduls | Abnahme | Abschluss |
|---|---|---|
| 8. bis 2. Kyu | Kyu-Prüfer | Kyu-Prüfer |
| 1. Kyu | Kreis-Dan-Vorsitzender | Kreis-Dan-Vorsitzender |
| 1. Dan bis eigener Dan-Grad | Dan-Prüfer | Dan-Prüfungsbeauftragter |

**Vergabe des Grades:** Beim Abschluss einer Prüfung prüft der Server je Teilnehmer, ob mit den neu bestandenen und
den früher bestandenen Modulen **alle Pflichtmodule** des angestrebten Grades erfüllt sind. Nur dann entsteht die
Graduierung (Datum = Prüfungsdatum, `pruefung_id` = diese Prüfung). Sonst werden nur die Modulergebnisse gespeichert.

**Module verfallen nicht.** Bestandene Module bleiben dauerhaft gültig, auch wenn der Grad lange nicht abgeschlossen
wird und auch nach dem Wechsel auf eine **neue Prüfungsordnung**: Bereits bestandene Module bleiben erhalten und werden
angerechnet. Für die Zuordnung alter zu neuen Modulen gibt es eine Anrechnungstabelle:

```sql
create table modul_anrechnungen (            -- altes Modul zählt als neues Modul
  altes_modul_id uuid not null references module,
  neues_modul_id uuid not null references module,
  primary key (altes_modul_id, neues_modul_id)
);
-- Serverprüfung: beide Module haben dieselbe ziel_art und ziel_stufe; ein altes Modul zählt höchstens für ein neues
-- Bei der Anmeldung gilt ein Modul auch dann als bestanden, wenn ein angerechnetes altes Modul bestanden ist
```

**Wartezeit und Mindestalter** (laut Prüfungsordnung je Grad) prüft der Server:

```sql
create table grad_voraussetzungen (
  pruefungsordnung_id uuid not null references pruefungsordnungen,
  ziel_art text not null, ziel_stufe smallint not null,
  wartezeit_monate int,                    -- seit der letzten Graduierung
  mindestalter_jahre int,
  primary key (pruefungsordnung_id, ziel_art, ziel_stufe)
);
```

- Module dürfen **vor Ablauf der Wartezeit** und **unabhängig vom Mindestalter** abgelegt werden. Die Anmeldung zu einer
  Modulprüfung wird dadurch nicht blockiert. Das Mindestalter gilt nur für die Graduierung.
- Die **Graduierung** entsteht erst, wenn alle Pflichtmodule bestanden **und** Wartezeit und Mindestalter erfüllt sind.
  Ist das letzte Modul vor Ablauf der Wartezeit bestanden, erzeugt ein täglicher Lauf die Graduierung am Tag, an dem die
  Wartezeit endet (Datum = dieser Tag, Bezug = Prüfung des letzten Moduls). Dasselbe gilt, wenn das **Mindestalter**
  erst später erreicht wird: maßgeblich ist der spätere der beiden Tage. Erst dann fällt die Graduierungsgebühr an.
  Als Prüfer der Graduierung gilt, wer die Prüfung des letzten Moduls abgeschlossen hat; die Urkunden-Nr. vergibt der
  Server beim Entstehen. Der Lauf setzt `pruefung_teilnehmer.graduierung_id` an der Prüfung des letzten Moduls.
- Vor dem Erzeugen prüft der Tageslauf erneut: Bezugsprüfung ist `abgeschlossen` (nicht `korrigiert`), die Person
  existiert und ist nicht zusammengeführt, alle Pflichtmodule sind (auch über Anrechnung) noch erfüllt. Fehlt das
  Geburtsdatum, entsteht keine Graduierung, sondern eine Meldung an den Heimatverein.
- Gebührenempfänger und Zahler bestimmt der Stand am **Tag des letzten Moduls** (Leistungsdatum), nicht der Tag des
  Laufs; ein Transfer dazwischen ändert den Empfänger nicht.
- Der Fortschritt zeigt zusätzlich „Wartezeit endet am …“.

**Pflichtlehrgänge:** Ein Grad kann die erfolgreiche Teilnahme an bestimmten Lehrgangstypen voraussetzen
(z. B. Pflichtlehrgang vor der Dan-Prüfung). Geprüft wird bei der **Anmeldung zur Prüfung** (Modul- oder Gesamtprüfung
dieses Grades); ohne Nachweis ist die Anmeldung nicht möglich.

```sql
create table grad_voraussetzung_lehrgaenge (
  pruefungsordnung_id uuid not null references pruefungsordnungen,
  ziel_art text not null, ziel_stufe smallint not null,
  lehrgangstyp_id uuid not null references lehrgangstypen,
  hoechstens_monate_alt int,               -- optional: Lehrgang darf nicht älter sein als …
  primary key (pruefungsordnung_id, ziel_art, ziel_stufe, lehrgangstyp_id)
);
```

Als Nachweis zählt ein nicht widerrufener Eintrag in `lehrgang_nachweise` ([9a.3](entwurf-lehrgaenge.md)) mit diesem
`lehrgangstyp_id`; bei Typen mit Erfolgskontrolle muss `ergebnis = 'erfolgreich'` sein.

**Fortschritt:** Die View `person_modulfortschritt` zeigt je Person und angestrebtem Grad die bestandenen und
fehlenden Module. Sichtbar für Prüfer (im Rahmen ihrer Filter), den Verein und die Person selbst bzw. ihre Eltern (4.4).

---

## 9. Prüfungen

### 9.1 Rechte

| Recht | Operationen | Bedeutung |
|---|---|---|
| `pruefung` | LESEN, ANLEGEN, ÄNDERN, LÖSCHEN, DELEGIEREN | Prüfung planen: Ort, Datum, Art, Teilnehmer; absagen |
| `pruefung_abnahme` | ÄNDERN, DELEGIEREN | Prüfung durchführen: Ergebnis je Teilnehmer und Modul erfassen |
| `pruefung_abschluss` | ÄNDERN, DELEGIEREN | Prüfung abschließen; speichert bestandene Module und erzeugt Graduierungen, wenn alle Module erfüllt sind |

Der Wertfilter (Zielgrad des Moduls bzw. angestrebter Grad) gilt für Abnahme und Abschluss je Teilnehmer.
`pruefung:LESEN` schließt die Kerndaten der Teilnehmer ein (Feldgruppe `kern`, ohne `kontakt`, auch ruhende
Mitglieder); Prüfer sehen ihre Prüflinge damit ohne zusätzliches `mitglieder:LESEN`.

**Wer prüft** (E105):

| Prüfung | Anlegen | Abnehmen und abschließen | Träger der Prüfung |
|---|---|---|---|
| 8.–2. Kyu | **Trainer** oder **Kyu-Prüfer** im Verein | **Kyu-Prüfer** | Verein (`verein_id`) |
| 1. Kyu | Kreis-Dan-Vorsitzender | **Kreis-Dan-Vorsitzender** des Kreises | Kreis (`verband_id`) |
| Dan | Bezirks-Dan-Beauftragter, Dan-Prüfungsorganisation des Landesverbands | **Dan-Prüfer** des Landesverbands (bis eigener Grad); Abschluss Dan-Prüfungsbeauftragter | Bezirk oder Landesverband |

Eine Kyu-Prüfung (8.–2. Kyu) legt der Trainer bzw. Kyu-Prüfer im Vereinskontext an; abnehmen und abschließen kann nur
ein Kyu-Prüfer, dessen Lizenzbereich den Verein umfasst (6.6). Teilnehmer einer Prüfung zum 1. Kyu sind nur Personen
mit angestrebtem 1. Kyu (`ist_1_kyu_pruefung`); in anderen Kyu-Prüfungen ist der 1. Kyu ausgeschlossen.

### 9.2 Tabellen

```sql
create table pruefungen (
  id uuid primary key,
  verein_id  uuid references vereine,
  verband_id uuid references verbaende,
  art        text not null check (art in ('kyu','dan')),
  pruefungsordnung_id uuid references pruefungsordnungen,  -- die am Prüfungsdatum gültige Ordnung
  titel text,                                              -- optional; sonst erzeugt die API „Kyu-Prüfung …“
  datum date, ort text,
  ist_1_kyu_pruefung boolean not null default false,       -- Prüfung zum 1. Kyu (Kreis); Kalender 9b.2
  check (not ist_1_kyu_pruefung or art = 'kyu'),
  -- datum und pruefungsordnung_id sind ab Status 'durchgefuehrt' Pflicht (Serverprüfung)
  status     text not null default 'geplant'
             check (status in ('geplant','durchgefuehrt','abgeschlossen','abgesagt','korrigiert')),
  angelegt_von uuid references benutzer,
  abgeschlossen_von uuid references benutzer, abgeschlossen_am timestamptz,
  check (num_nonnulls(verein_id, verband_id) = 1)
);
create table pruefung_teilnehmer (
  pruefung_id      uuid references pruefungen,
  person_id        uuid references personen,
  angestrebt_art   text not null check (angestrebt_art in ('kyu','dan')), angestrebt_stufe smallint not null,
  -- Serverprüfung: angestrebt_art = pruefungen.art; angestrebt = nächster Grad nach dem aktuellen (Ausnahme Nacherfassung)
  abgenommen_von   uuid references benutzer,
  graduierung_id   uuid references graduierungen,   -- nur gesetzt, wenn mit dieser Prüfung alle Module erfüllt sind
  primary key (pruefung_id, person_id)
);
create table pruefung_teilnehmer_module (  -- welche Module der Teilnehmer in dieser Prüfung ablegt
  id uuid not null unique,                   -- Bezug für abrechnungspositionen
  pruefung_id uuid, person_id uuid,
  modul_id    uuid not null references module,
  ergebnis    text check (ergebnis in ('bestanden','nicht_bestanden','nicht_erschienen')),   -- nie löschen
  abgenommen_von uuid references benutzer,
  primary key (pruefung_id, person_id, modul_id),
  foreign key (pruefung_id, person_id) references pruefung_teilnehmer
);
```

Bei der Anmeldung wählt man je Teilnehmer die Module dieser Prüfung (Vorschlag: alle noch fehlenden Module des
angestrebten Grades). Bereits bestandene Module können nicht erneut angemeldet werden. Der Server prüft, dass jedes
Modul zum angestrebten Grad und zur Prüfungsordnung der Prüfung gehört. Teilnehmer und Module lassen sich nur im
Status `geplant` hinzufügen oder entfernen. Hat ein Teilnehmer ein Modul inzwischen anderswo bestanden, wird es beim
Abschluss übersprungen (kein Fehler, keine Gebühr).

### 9.3 Statusablauf

```
geplant ──(pruefung: ÄNDERN)──────────────▶ geplant
geplant ──(pruefung: ÄNDERN, ausdrücklich)▶ durchgefuehrt   → danach sind Ergebnisse (pruefung_abnahme) erfassbar
durchgefuehrt ──(pruefung_abschluss)───────▶ abgeschlossen   → nur wenn jedes Modul ein Ergebnis hat (`nicht_erschienen`
                                                               = keine Gebühr); Modulergebnisse speichern; Graduierung nur bei
                                                               allen Pflichtmodulen; Prüfungsgebühren; eine Transaktion
geplant ──(pruefung: LÖSCHEN)──────────────▶ abgesagt        → Status, kein echtes Löschen
durchgefuehrt ──(pruefung: LÖSCHEN)────────▶ abgesagt        → nur solange kein Ergebnis erfasst ist
abgeschlossen ──(pruefung_abschluss: LÖSCHEN)▶ korrigiert    → Landesverband bzw. Abschließender: Ergebnisse und
                                                               Graduierungen per Soft Delete zurücknehmen, Gutschrift,
                                                               Audit
korrigiert ──(pruefung_abschluss: ÄNDERN)──▶ durchgefuehrt   → Neuerfassung der Ergebnisse, danach erneuter Abschluss
```

Die Korrektur nimmt auch Graduierungen zurück, die der Tageslauf mit Bezug auf diese Prüfung erzeugt hat, und meldet
spätere Graduierungen derselben Person zur Prüfung. Gutschriften für bereits abgerechnete Positionen laufen über die
nächste Abrechnung bzw. den nächsten Rechnungslauf; Forderungen beim Verein (Dojo Master Pro) werden als storniert
gemeldet.

### 9.4 Regeln

- **Niemand prüft sich selbst:** Ist der Handelnde Teilnehmer der Prüfung, werden Abnahme und Abschluss für ihn
  abgelehnt. Hat er einen aktiven Zugriff nach 4.4 auf den Teilnehmer (eigenes Kind), zeigt der Server einen Hinweis.
- Für `wert_bis_eigener_grad` zählt der Grad des Prüfers **vor** dem Abschluss; ein in derselben Prüfung erworbener Grad zählt nicht.
- **Kein Vier-Augen-Prinzip:** Wer abgenommen hat, darf auch abschließen (sofern er das Abschlussrecht hat).
- Abschluss ist idempotent: ein zweiter Abschluss erzeugt keine weiteren Graduierungen.
- Der Abschluss (bzw. für die Graduierung der Tageslauf, 8.1) erzeugt laut `gebuehren_empfaenger` je abgelegtem Modul eine **Modulgebühr** und, wenn dabei eine
  Graduierung entsteht, eine **Graduierungsgebühr** ([6.3](entwurf-finanzen.md)).

---

## 9a. Lehrgänge

Ausgelagert nach [entwurf-lehrgaenge.md](entwurf-lehrgaenge.md) (Abschnitte 9a.1–9a.6 mit gleicher Nummer).

## 9b. Kalender, Turniere und Veranstaltungen

Ausgelagert nach [entwurf-kalender-veranstaltungen.md](entwurf-kalender-veranstaltungen.md) (Abschnitte 9b.1–9b.7).

---

## 10. Berechtigungsmatrix (Seed)

Bereich: V = Verein, K = Kreis, B = Bezirk, L = Landesverband, DJB = bundesweit. Dies ist die vollständige
Seed-Matrix; die Rechte aus Lehrgängen (9a.2) und Kalender (9b.7) sind hier eingetragen.

**Rechtequellen außerhalb von Rollen und Lizenzen** (in `darf()` und im Listen-Prädikat wie eine Quelle behandelt):
- *alle angemeldeten Benutzer*: feste Seed-Berechtigungen ohne Bereich (Zeile unten);
- *Ersteller und Organisatoren* eines Termins (`angelegt_von`, `termin_organisatoren`): `ÄNDERN`/`LÖSCHEN` am Termin
  und `LESEN`/`ÄNDERN` der Teilnehmerliste, nur für diesen Termin.

### 10.1 Rollen

| Rolle | Ebene | Berechtigungen | Datenfilter |
|---|---|---|---|
| Super-Admin | global | alles (`benutzer.ist_super_admin`) | – |
| Admin | V | Verein vollständig verwalten, Benutzer und Rechte im Verein; DELEGIEREN für vereinsbezogene Rechte (z. B. `ueberweisung`) ohne deren Nutzung; `judopass_antrag:LESEN/ANLEGEN/ÄNDERN` (Erteilung, Änderung, Verlängerung; ÄNDERN = zurückziehen); `zahlungsweise:LESEN/ÄNDERN` (gegenüber dem Landesverband); `gebuehren:LESEN/ÄNDERN` (eigene Vereinsgebühren); `mitgliedschaftsantrag:LESEN/ÄNDERN` (annehmen, ablehnen); `rolle:LESEN/ANLEGEN/ÄNDERN/LÖSCHEN` (vereinseigene Rollen, 5.2); `turnier_meldung:LESEN/ANLEGEN/ÄNDERN`, `mannschaft:LESEN/ANLEGEN/ÄNDERN/LÖSCHEN` (9b.7) | – |
| **Trainer** | V | `mitglieder:LESEN`, `graduierung:LESEN`; `pruefung:LESEN/ANLEGEN/ÄNDERN/LÖSCHEN` (Kyu-Prüfungen im Verein anlegen und planen, keine Abnahme); `turnier_meldung:LESEN/ANLEGEN/ÄNDERN`, `mannschaft:LESEN/ANLEGEN/ÄNDERN/LÖSCHEN`; `lehrgang_teilnahme:LESEN` | Prüfung: Wert Kyu 8.–2.; Lesen ohne `kontakt` |
| **Kassierer**, **Kassenprüfer** | V | wie bisher (`ueberweisung`, Beitragsdaten), überführt aus den alten Vereins-Rechten | – |
| *(alle angemeldeten Benutzer)* | – | `lehrgang:ANLEGEN/ÄNDERN/LÖSCHEN` für eigene Anträge; `turnier:ANLEGEN`, `veranstaltung:ANLEGEN` (9b); `mitgliedschaftsantrag:ANLEGEN` für sich bzw. Personen mit Zugriff (4.4) | – |
| Mitglied | V | keine Rechte über die feste Regel 4.4 hinaus (eigene Daten und Personen mit Zugriff) | – |
| **Bezirks-Dan-Beauftragter** | B | `mitglieder:LESEN`, `graduierung:LESEN`; `pruefung:LESEN/ANLEGEN/ÄNDERN/LÖSCHEN`; `lehrgang_freigabe:ÄNDERN` (Lehrgänge des Bezirks), `lehrgang_teilnahme:LESEN/ÄNDERN` | Ab 1. Kyu (Rang ≥ 9, Kandidaten für den 1. Dan); nur aktive Mitglieder (Nutzerentscheid 2026-11-24); Feldgruppen ohne `kontakt` |
| **Landesvertreter** | L | `vereine:LESEN/ÄNDERN/LÖSCHEN/ANLEGEN`; `mitglieder:LESEN`; `mitglieder:ÄNDERN` | Lesen: ohne `kontakt`. Ändern: nur Felder Vorname, Nachname, Geburtsdatum, Nationalität (und Passfoto), nur Personen mit Lizenz Judopass (auch abgelaufen) – in der Regel durch Genehmigung eines Änderungsantrags (6.1, `judopass_antrag:LESEN/ÄNDERN`), im Ausnahmefall direkt. Verlängerungen freigeben (`judopass_antrag:ÄNDERN`). Dazu `mitglieder:LÖSCHEN` und `personen_zusammenfuehrung:ÄNDERN` für Dubletten (4.2a) |
| *(Ergänzung Admin, Landesvertreter)* | V / L | `transfer:LESEN/ANLEGEN/ÄNDERN` (senden, zurückziehen, eingehende annehmen/ablehnen); `lehrgang:LESEN`, `lehrgang_teilnahme:LESEN/ÄNDERN` | Landesvertreter: nur Vereine im eigenen Teilbaum |
| **Lehrgangsfreigabe** | L / DJB | `lehrgang:LESEN`, `lehrgang_freigabe:ÄNDERN` (Lehrgänge des eigenen Verbands) | – |
| **Dan-Prüfungsorganisation** | L | `pruefung:LESEN/ANLEGEN/ÄNDERN/LÖSCHEN` (Dan-Prüfungen im Landesverband) | Wert: Dan |
| **Verbandskassierer** | K / B / L / DJB | `rechnungslauf:LESEN/ANLEGEN/ÄNDERN`, `forderungen:LESEN/ÄNDERN` (Rücklastschrift, Erlass), `mandate:LESEN` (nur Mandate mit eigenem Verband als Gläubiger) | keine Kontaktdaten außer Kontoinhaber |
| **Landesverbands-Admin** | L | Verbandsrollen im Landesverband und darunter vergeben und entziehen; `gebuehren:LESEN/ÄNDERN` (Gebühren des Landesverbands); `lehrgangstyp:LESEN/ANLEGEN/ÄNDERN/LÖSCHEN`; `lizenz:ANLEGEN/ÄNDERN` (Prüferlizenzen, bundesweite Lizenzen); `lizenz_aussetzung:ANLEGEN/ÄNDERN` (Judopass) | – |
| **DJB-Admin** | DJB | `lehrgangstyp:LESEN/ANLEGEN/ÄNDERN/LÖSCHEN` für DJB-weite Typen; `lizenz:ANLEGEN/ÄNDERN` für bundesweite Lizenzen; `lizenz_aussetzung:ANLEGEN/ÄNDERN` (Startrechte); Landesverbands-Admins vergeben | – |
| *(Veranstalter-Admins)* | V / Verband | `turnier:ÄNDERN/LÖSCHEN`, `veranstaltung:ÄNDERN/LÖSCHEN`, `turnier_meldung:LESEN`, `veranstaltung_anmeldung:LESEN/ÄNDERN` für Termine des eigenen Vereins bzw. Verbands | – |

Die bisherigen Vereins-Rechte `trainer`, `pruefer`, `kassierer`, `kassenpruefer` werden zu den Seed-Rollen Trainer,
Kyu-Prüfer (als Lizenz, manuelle Zuordnung), Kassierer und Kassenprüfer überführt.

**Verbandsebene allgemein:** Verbandsrollen sehen **keine Kontaktdaten** (Anschrift, Telefon, E-Mail).

### 10.2 Lizenzen

| Lizenz | Bereich | Berechtigungen | Datenfilter |
|---|---|---|---|
| **Kyu-Prüfer** | verband (wirkt in den Vereinen des Bereichs, 6.6) | `pruefung:LESEN/ANLEGEN/ÄNDERN/LÖSCHEN`, `pruefung_abnahme:ÄNDERN`, `pruefung_abschluss:ÄNDERN` – Kyu-Prüfungen im Verein anlegen, durchführen, abschließen | Wert: Kyu, 8. bis 2. Kyu (den 9. Kyu hat jedes Mitglied automatisch) |
| **Kreis-Dan-Vorsitzender** | K | `mitglieder:LESEN`, `graduierung:LESEN`; `lehrgang:LESEN`, `lehrgang_freigabe:ÄNDERN` (Lehrgänge im Kreis freigeben), `lehrgang_teilnahme:LESEN`; `pruefung:LESEN/ANLEGEN/ÄNDERN/LÖSCHEN`, `pruefung_abnahme:ÄNDERN`, `pruefung_abschluss:ÄNDERN` – nimmt Prüfungen zum 1. Kyu im Kreis ab | Lesen: Rang ≥ 8 (ab 2. Kyu), ohne `kontakt`. Prüfen: Wert 1. Kyu |
| **Dan-Prüfer** | L | `pruefung_abnahme:ÄNDERN`, `pruefung:LESEN` – nimmt Dan-Prüfungen im Landesverband ab | Wert: 1. Dan bis eigener Dan-Grad |
| **Dan-Prüfungsbeauftragter** | L | `pruefung_abschluss:ÄNDERN`, `pruefung:LESEN` | Wert: Dan |

Folge für Dan-Prüfungen: Ein Dan-Prüfer nimmt ab, abschließen kann nur ein Dan-Prüfungsbeauftragter
(dieselbe Person darf beides, wenn sie beide Lizenzen hat).

---

## 11. Auflösung der wirksamen Berechtigungen

### 11.1 Anmeldekontext: Vereine sehen nur ihre eigenen Mitglieder

Jede Sitzung hat genau **einen aktiven Kontext**: einen Verein oder einen Verband. Er steht im Token (`verein_id` bzw.
`verband_id`) und wird über `POST /auth/kontext-wechseln` gewechselt (bisher `/auth/verein-wechseln`). Nach der Anmeldung
ist der Heimatverein der verknüpften Person aktiv, sofern der Benutzer dort `freigegeben` ist, sonst der zuletzt
genutzte freigegebene Verein, sonst der erste wählbare Verbandskontext; ohne jeden Kontext sieht der Benutzer nur seine
Person und Personen mit Zugriff (4.4). Bei Kontextwechsel und Token-Erneuerung prüft der Server erneut, ob der Kontext
noch wählbar ist (z. B. nach Ablauf der einzigen Lizenz).

- **Im Vereinskontext A** wirken die Vereinsrollen und vereinsbezogenen Direktrechte für A sowie die **Lizenzen, deren
  Bereich A umfasst** (6.6, z. B. Kyu-Prüfer). Sichtbar sind nur
  Personen mit einer Mitgliedschaft in A und nur **diese** Mitgliedschaft. Mitgliedsnummer, Status, Eintritt usw. aus
  Verein B bleiben unsichtbar, auch wenn dieselbe Person in beiden Vereinen ist.
- Ist der Benutzer auch in Verein B freigegeben, wechselt er den Kontext und sieht dann **nur** die Mitglieder von B.
  Es gibt keine gemeinsame Sicht über A und B.
- **Im Verbandskontext** wirken nur die Verbandsrollen und Lizenzen mit Bereich in diesem Verband (z. B. Landesvertreter,
  Kreis-Dan-Vorsitzender). Ein Verbandskontext ist nur wählbar, wenn der Benutzer dort eine Rolle oder Lizenz hat.
- **Unabhängig vom Kontext** sieht jeder Benutzer seine eigene Person und alle Personen mit Zugriff nach 4.4
  (eigene Kinder auch dann, wenn sie in einem anderen Verein sind).
- Personenbezogene Daten gehören der Person. Verein A sieht deshalb auch Grade und Lizenzen, die die Person anderswo
  erworben hat – aber nur für Personen, die Mitglied in A sind. **Positivliste** dessen, was jeder Verein der Person sieht:

  | Sieht jeder Verein der Person | Sieht nur … |
  |---|---|
  | Name, Geburtsdatum, Geschlecht, Nationalität, Passfoto | – |
  | Kontaktdaten (lesen; ändern nur Heimatverein) | – |
  | Graduierungen, bestandene Module | – |
  | Lizenzen inkl. Judopass, Wettkampflizenzen, Trainer-, Prüferlizenzen, Erste Hilfe | – |
  | Führungszeugnis: nur „liegt vor, gültig bis“ | Inhalt der Einsichtnahme: der Verein, der sie vorgenommen hat |
  | Lehrgangsnachweise | – |
  | – | Mitgliedschaftsdaten (Nr., Eintritt, Status, Beiträge): nur der jeweilige Verein |
  | – | Bankkonten und Mandate: Regeln in [6.5](entwurf-finanzen.md) |
  | – | Judopass-Anträge: Heimatverein und dessen Landesverband |

### 11.2 Prüfung einer Aktion

Eine Aktion (Benutzer U, Recht R, Operation O, Ziel Z) ist erlaubt, wenn **mindestens eine im aktiven Kontext wirksame
Quelle** sie vollständig erlaubt:

1. Quelle ist gültig: Vereinsrolle (Zugehörigkeit freigegeben, Rolle im Gültigkeitszeitraum), Verbandsrolle (im
   Gültigkeitszeitraum), Lizenz (gültig, Inhaber-Person mit U verknüpft), direkte Berechtigung (im
   Gültigkeitszeitraum), Seed-Recht aller angemeldeten Benutzer oder Ersteller/Organisator des Ziel-Termins (10).
2. Die Quelle enthält R × O.
3. Z liegt im Bereich der Quelle (Verein gleich, oder Verein/Verband im Teilbaum laut `verband_pfade`).
   Bei Personen mit mehreren Mitgliedschaften genügt eine Mitgliedschaft im Bereich – **außer** für `mitglieder:LÖSCHEN`,
   `personen_zusammenfuehrung` und `judopass_antrag`/Judopass-Daten: Dafür muss der **Heimatverein** im Bereich liegen
   (nur der Landesverband des Heimatvereins).
4. Z erfüllt den Datenfilter **dieser** Quelle: Subjekt-, Wert- und Feldfilter.

**ODER über Quellen, UND innerhalb einer Quelle.** Filter verschiedener Quellen werden nie kombiniert.

Umsetzung:
- View/Funktion `benutzer_wirksame_berechtigungen(benutzer_id)` liefert (Quelle, Recht, Operation, Bereich, Datenfilter).
- Eine einzige Servicefunktion `darf(benutzer, recht, operation, ziel)` für Einzelprüfungen.
- Listenabfragen erzeugen aus Bereichen und Filtern ein SQL-Prädikat; Ergebnis muss mit der Einzelprüfung übereinstimmen.
- Das JWT enthält nur eine Kurzform (aktiver Verein, Rollen, Lizenzschlüssel); die Prüfung im Einzelfall macht der Server.
  Apps fragen Details über `GET /ich` ab.

---

## 12. Auswirkungen auf andere Projekte

| Projekt | Auswirkung |
|---|---|
| Kyu-Manager Pro | Prüfungen und das Rückschreiben von Graduierungen (`POST /v1/graduierungen`) laufen künftig über die Prüfungs-API des Stammdaten-Servers; neuer Abgleich `/v2/abgleich` liefert Personen und Mitgliedschaften, `/v1/abgleich` läuft bis zur Umstellung parallel (13) |
| Dojo Master Pro | eigene Prüfungen/Graduierungen werden auf den Stammdaten-Server umgestellt; **Bankkonten und SEPA-Mandate der Beiträge wandern in den Stammdaten-Server** (Migration der vorhandenen Mandate, Mandatsreferenzen bleiben gleich); Beitragseinzug (SEPA/FinTS) bleibt in Dojo Master Pro |
| Hajime Pro | Judopass und Wettkampflizenz über `lizenzen` + `lizenzarten`; Teilnehmer über Personen |
| Alle | Token-Inhalt ändert sich (Rollen/Lizenzen statt fester `rolle`); Feinprüfung über `GET /ich` |

Diese Umstellungen sind je App ein eigenes Epic in der BMAD-Planung (`_bmad-output/`).

---

## 13. Migration vom Ist-Stand (Überblick)

1. `mitglieder` → `personen` + `mitgliedschaften`. Zusammengeführt wird automatisch nur über `djb_id` bei gleichem
   Namen und Geburtsdatum. Treffer über **Nachname, Vorname und Geburtsdatum ohne `djb_id`** kommen auf eine
   Konfliktliste für den jeweiligen Landesverband (E106). Jede alte Zeile wird in der Zuordnungstabelle festgehalten:
   ```sql
   create table mitglieder_migration (
     alt_mitglied_id uuid primary key, alt_verein_id uuid not null,
     person_id uuid not null references personen, mitgliedschaft_id uuid not null references mitgliedschaften
   );
   ```
2. `graduierungen`, `lizenzen`: `mitglied_id` → `person_id`; `lizenzen.art` → `lizenzart_id` nach Zuordnungstabelle
   (`judopass` → Judopass; `wettkampflizenz` → Einzelstartrecht, Mannschaftsstartrechte manuell; `trainer_*` → Trainer
   A/B/C; `pruefer_lizenz`, `graduierungslizenz`, `efz_pruefer`, `sonstige` → **manuelle Zuordnung**, bis dahin ohne
   Rechte). Nummern-Duplikate derselben Person werden zusammengeführt, andere als Konfliktliste ausgegeben.
   `graduierungen.quelle`: `manuell` → `nacherfassung`; `dojo-master-pro`, `kyu-manager-pro` → `import`, die Herkunft
   bleibt in einer Spalte `herkunft_app`. Personen ohne Graduierung erhalten den 9. Kyu.
3. `benutzer_vereine.rolle` (admin/mitglied) → `benutzer_vereinsrollen` (Seed-Rollen); `mitglied_id` → `personen.benutzer_id`.
4. `benutzer_rechte` → Seed-Rollen bzw. `benutzer_berechtigungen` (Recht → Recht × Operationen nach Seed-Tabelle);
   Kombinationen werden zu mehreren Vereinsrollen.
5. `erziehungsberechtigte` → `personen_zugriffe` (art `erziehungsberechtigt`, umfang `aendern`).
6. `benutzer.heimatverein_id` entfällt; `personen.heimatverein_id` = Verein, der den Judopass hält, sonst ältester aktiver Verein.
7. `lizenzen_dokument_fk` entfernen, dann `lizenzen.verein_id`; `dokumente.person_id` aus der Lizenz bzw. dem Mitglied füllen; Passfoto an den Judopass hängen.
8. `fuehrungszeugnis_einsichten` → Lizenzen der Art „Führungszeugnis“ an der Person, je einsehendem Verein.
9. Kontaktdaten aus `mitglieder` → `personen` (bei mehreren Zeilen derselben Person: Wert des Heimatvereins).
10. `mitglieder.judopass_url` und Judopass-Lizenzen → `lizenzen` mit `code_inhalt`; Wettkampflizenzen → Einzel-/Mannschaftsstartrecht mit `fuer_verein_id` und `saison`.
11. Weitere Tabellen mit `mitglied_id` (`dokumente`, `mitglied_gruppen` u. a.) auf `person_id` bzw. `mitgliedschaft_id`
    umstellen. Ebenso anpassen: die Abgleich-Views, die Datenschutz-Bereinigungsfunktion (bisher auf `mitglieder`,
    `erziehungsberechtigte`, `benutzer_rechte`), `einmal_tokens.rolle` → `rolle_id`, `dokumente.art` und
    `aufbewahrungsfristen`. Checks (z. B. `graduierungen.quelle`) werden **vor** dem Umschreiben der Werte angepasst.
12. Spalten mit `not null` (z. B. `lizenzen.lizenzart_id`, `lizenzen.person_id`, `personen.heimatverein_id`) in drei
    Schritten: nullable anlegen, befüllen, `set not null`.
13. Tabellen in Abhängigkeitsreihenfolge anlegen (Datenfilter, Lizenzarten, Bankkonten/Mandate vor Rollen,
    Zahlungsweise und Abrechnungen); die Skizzen in diesem Dokument folgen der Lesereihenfolge, nicht der Anlagereihenfolge.
14. **Vereine ohne Kreis** werden vor der Migration einem Kreis zugeordnet (Liste je Landesverband, E101).
15. **Abgleich-API:** `/v2/abgleich` liefert Personen und Mitgliedschaften (mit `alt_mitglied_id` aus der
    Zuordnungstabelle); `/v1/abgleich` liefert bis zur Umstellung aller Apps weiter Mitglieder-Zeilen aus einer View
    über `mitgliedschaften` (E106).

Finanzdaten (Gebühren, Bankkonten, Mandate, Zahlungsweise) migriert [entwurf-finanzen.md](entwurf-finanzen.md) (6.8).

Prüfkriterium: Kein Benutzer erhält durch die Migration mehr Rechte als vorher; gewollte Einschränkungen
(Kontexttrennung 11.1) werden als Liste der Unterschiede ausgegeben und geprüft.

---

## 14. Testschwerpunkte (Vorschau, noch kein Test-Design)

Tests zu Finanzen, Lehrgängen und Kalender stehen in den jeweiligen Dokumenten.

- **P0** Vereinstrennung: im Kontext Verein A keine Mitglieder und keine Mitgliedschaftsdaten aus B, auch nicht für Personen in beiden Vereinen; nach Kontextwechsel nur B; Vereinsrechte aus A wirken nicht in B; Verbandsrechte nur im Verbandskontext.
- **P0** Zugriff auf Personen: Eltern und Kind (ab 14) gleichzeitig; Kind in fremdem Verein für Eltern sichtbar; ab 18 ruht der Elternzugriff bis zur Freischaltung, nach Widerruf kein Zugriff.
- **P0** Judopass-Antrag (Änderung): Verein ändert Name eines Judopass-Inhabers direkt → abgelehnt; Genehmigung ändert Daten und erzeugt neuen Aztec-Code atomar; Ablehnung ändert nichts; veraltete `alt`-Werte → Genehmigung abgelehnt; fremder Landesverband sieht den Antrag nicht.
- **P0** Dubletten: Zusammenführen verliert keine Graduierung, Lizenz oder Mitgliedschaft; Konflikte werden vor dem Ausführen gemeldet; Löschen einer Person mit Graduierungen wird abgelehnt; fremder Landesverband darf nicht.
- **P0** Module: Gürtel erst nach dem letzten Pflichtmodul, auch über mehrere Prüfungen; Modul eines anderen Grades nur mit passender Lizenz (z. B. Kyu-Prüfer nimmt kein 1.-Kyu-Modul ab); bestandenes Modul nicht doppelt (auch nicht über Anrechnung); nicht bestandenes Modul vergibt nichts; inzwischen anderswo bestandenes Modul wird beim Abschluss übersprungen.
- **P0** Wartezeit: Module vor Ablauf erlaubt; Graduierung erst nach Ablauf und mit Mindestalter; Tageslauf vergibt sie genau einmal; alte Module zählen nach Prüfungsordnungswechsel; korrigierte Bezugsprüfung → keine Graduierung; ohne Geburtsdatum → Meldung statt Graduierung.
- **P0** Wer prüft: Trainer legt Kyu-Prüfung im Verein an, kann aber nicht abnehmen; Kyu-Prüfer legt an, nimmt ab und schließt ab, auch im Vereinskontext; Prüfung zum 1. Kyu nur durch den Kreis-Dan-Vorsitzenden des Kreises; Dan-Prüfer eines anderen Landesverbands abgelehnt; Bezirks-Dan-Beauftragter sieht Inhaber des 1. Kyu; Prüfer sieht die Kerndaten seiner Prüflinge, auch ruhender Mitglieder.
- **P0** Prüfungskorrektur: `korrigiert` → Neuerfassung → erneuter Abschluss; Tageslauf-Graduierung wird mit zurückgenommen; Neuerfassung erzeugt die Gebühr erneut.
- **P0** Rollen: zwei Vereinsrollen addieren sich; vereinseigene Rolle mit `transfer` oder nicht delegierbarem Recht abgelehnt; vergebene Rolle nicht löschbar; nach Austritt wirken Vereinsrollen und Direktrechte nicht mehr.
- **P0** Delegation: ohne Enddatum oder länger als zwei Jahre abgelehnt; `vergeben_durch_super_admin` per API nicht setzbar.
- **P0** Zugriff 4.4: ohne Geburtsdatum kein Zugriff und kein Konto; Konto unter 14 abgelehnt; Vormund mit Nachweis ruht ab 18 nicht, Bevollmächtigter schon.
- **P0** Startrechte: ausgesetztes Mannschaftsstartrecht gilt im Aussetzungszeitraum nicht, davor und danach schon.
- **P0** Bereichsgrenzen (Nachbarkreis, anderer Landesverband), Grenzwerte der Rangfilter, Wertfilter bei ANLEGEN und ÄNDERN (alter und neuer Wert), Feldfilter beim Schreiben (Landesvertreter ändert E-Mail → abgelehnt; Person ohne Judopass → abgelehnt).
- **P0** Lizenzablauf (gestern/heute), Lizenz eines fremden Verbands, Ausstellen nur durch Landesverband.
- **P0** Delegation: nur eine Ebene, nicht außerhalb des eigenen Bereichs, nicht mit lockererem Filter.
- **P0** Prüfungen: Abnahme/Abschluss je Lizenz, Selbstprüfung, „bis eigener Dan-Grad“, keine Quellen-Mischung.
- **P0** Heimatverein: liegt immer beim Verein des Judopasses; nie leer; Austritt ändert den Heimatverein nicht; Mitgliedschaftsantrag ändert den Heimatverein nie; Heimatverein darf gekündigte Mitgliedschaft haben; aufgelöster Verein → Landesverband überträgt; zweiter offener Transfer abgelehnt; Mitgliedsnummer wird erzeugt und ist je Verein eindeutig, auch bei parallelen Annahmen.
- **P0** Mitgliedschaftsantrag: es gibt keinen Such-Endpunkt; Pass-Nr. mit falschem Nachnamen oder Geburtsdatum → abgelehnt ohne Grundangabe; Online-Antrag ohne Pass-Nr. übernimmt die Person aus dem Konto (keine Dublette); Verein B sieht vor Annahme nur die Antragsdaten; Fehlversuche begrenzt; zweiter offener Antrag abgelehnt.
- **P0** Verbandsbaum: Verein ohne Kreis abgelehnt; Verbandswechsel lässt alte Positionen beim alten Landesverband.
- **P0** Dokumente: Passfoto und Nachweise bleiben nach Transfer bei der Person; fremder Verein ohne Mitgliedschaft sieht sie nicht.
- **P0** Verlängerung: ohne Freigabe des Landesverbands kein neues `gueltig_bis` und keine Marke; `gueltig_bis` = 31.12. des beantragten Jahres; zweiter offener Verlängerungsantrag abgelehnt; stornierte Marke gibt das Jahr frei und setzt `gueltig_bis` zurück; genau eine Marke je Pass und Jahr (auch bei paralleler Sammelverlängerung).
- **P0** Judopass-Anträge: nicht erlaubtes Feld in `aenderungen` abgelehnt; geändertes Foto seit Antrag → Genehmigung abgelehnt; zweiter wirksamer Judopass auch beim Genehmigen abgelehnt.
- **P0** Transfer: Heimatwechsel lässt beide Mitgliedschaften bestehen und ändert nur den Heimatverein; Vereinswechsel setzt die alte auf `ausgetreten`; ruhendes/ausgetretenes Mitglied mit Pass transferierbar; vorhandene Mitgliedschaft in B wird genutzt, keine zweite angelegt; Mitgliedschaft einer anderen Person abgelehnt (FK); nur der Verein mit dem Pass darf senden; Pass inzwischen woanders → `abgebrochen`; offene Judopass-Anträge gehen an B.
- **P0** Dubletten über Landesgrenzen: der Landesverband des Heimatvereins der älteren Zeile führt zusammen; Zusammenführen bei offenem Transfer gesperrt.
- **P0** Elternzugriff: ruht ab 18 ohne Freischaltung und endet nach einem Jahr; neues Mitglied hat 9. Kyu (sperrt das Löschen nicht); fremder Landesverband einer Zweitmitgliedschaft darf nicht löschen.
- **P1** Aztec-Code: erzeugter Inhalt passt mit echtem Foto in die Kapazität, Signatur prüft, manipulierter Inhalt fällt durch.
- **P1** Eltern mit mehreren Kindern, Mehrfachmitgliedschaft, Baumänderung.
- **P1** Startrechte: Wechsel des Vereins eines Mannschaftsstartrechts erzeugt neue Lizenzzeile; überlappende Aussetzungen abgelehnt.
- **P2** Migration (keine Rechte-Erweiterung, Unterschiedsliste geprüft; Zuordnungstabelle vollständig; `/v1/abgleich` liefert dasselbe wie vorher), Listenleistung auf Landesebene.

---

## 15. Entscheidungen

Entscheidungen zu Finanzen stehen in [entwurf-finanzen.md](entwurf-finanzen.md), zu Lehrgängen in [entwurf-lehrgaenge.md](entwurf-lehrgaenge.md); die Nummern bleiben gleich.

| # | Entscheidung |
|---|---|
| E1 | Rechte × fünf feste Operationen; keine weitere Operation (auch nicht für Prüfungen) |
| E2 | Rollen als Tabelle, Vereins- und Verbandsebene |
| E3 | „Lizenz“ bleibt Lizenz (bestehende Tabelle, erweitert); Gürtel sind „Graduierungen“ |
| E4 | Prüfungen gehören in den Stammdaten-Server |
| E5 | Prüferlizenzen stellt der Landesverband aus |
| E6 | Delegation nur eine Ebene; delegierte Rechte bleiben bestehen, wenn der Geber sein DELEGIEREN verliert |
| E7 | Kein Vier-Augen-Prinzip bei Prüfungen |
| E8 | Kyu-Prüfer: Abnahme und Abschluss 8.–2. Kyu; Kreis-Dan-Vorsitzender: Abnahme und Abschluss 1. Kyu; Dan-Prüfer: Abnahme 1. Dan bis eigener Grad; Dan-Prüfungsbeauftragter: Abschluss Dan |
| E9 | Bezirks-Dan-Beauftragter (eine Rolle): Personen ab 1. Kyu im Bezirk sehen (E107), Dan-Prüfungen anlegen |
| E10 | Verbandsebene sieht keine Kontaktdaten; der Landesvertreter ändert bei Personen mit Judopass nur Vorname, Nachname, Geburtsdatum, Nationalität und Passfoto, in der Regel per Antrag (E32) |
| E11 | „Mit Judopass“ zählt auch ein abgelaufener Judopass |
| E12 | Trainerlizenzen A, B, C stellen DJB oder Landesverband aus |
| E13 | Verbandsrollen vergibt der Landesverbands-Admin |
| E14 | Kyu-Prüfungen (8.–2. Kyu) legen Kyu-Prüfer oder Trainer im Verein an (E105) |
| E15 | Kontaktdaten liegen an der Person |
| E16 | Auf die Daten einer Person dürfen mehrere Benutzer zugreifen: sie selbst und beliebig viele Berechtigte (Eltern …), gleichzeitig |
| E17 | Eltern sehen Daten und Judopass ihrer Kinder; der Judopass ist eine befristete Lizenz mit Aztec-Code |
| E18 | Wettkampflizenz als Einzelstartrecht und als Mannschaftsstartrecht, jeweils für einen Verein |
| E20 | Eigener Zugang für Kinder ab 14 |
| E21 | Judopass stellt der Landesverband aus, Wettkampflizenzen der DJB |
| E22 | Mannschaftsstartrechte sind in der Saison änderbar und für eine Dauer aussetzbar |
| E23 | Trainerlizenzen A/B/C, Erste Hilfe und Führungszeugnis geben keine Rechte |
| E24 | Der Kreis-Dan-Vorsitzende legt die Prüfung zum 1. Kyu an und nimmt sie im Kreis ab |
| E25 | Vereine sehen nur ihre eigenen Mitglieder; es gilt immer genau ein aktiver Kontext (Verein oder Verband) |
| E26 | Der Judopass-Aztec-Code enthält verschlüsselt Vorname, Name, Geburtsdatum und Passfoto (klein); er wird bei Erteilung, Verlängerung und jeder Datenänderung neu erzeugt (Liste in 6) |
| E27 | Transfer: Der abgebende Verein oder der Landesverband sucht den aufnehmenden Verein und sendet das Mitglied dorthin |
| E28 | Änderungen an Vorname, Nachname, Geburtsdatum, Nationalität und Passfoto von Judopass-Inhabern entscheidet der Landesverband; dabei entsteht ein neuer Aztec-Code |
| E29 | Ausgelesen wird der Aztec-Code mit einer JudoPass-App |
| E31 | Der abgebende Verein darf über Landesgrenzen transferieren |
| E32 | Änderungen an Vorname, Nachname, Geburtsdatum, Nationalität, Foto: Antrag des Vereins in die Eingangsbox des Landesverbands; dieser genehmigt oder lehnt ab |
| E33 | Aztec-Code statt QR-Code; bei jeder genehmigten Änderung erzeugt der Server einen neuen |
| E34 | Der frühere „führende Verein“ heißt Heimatverein (Bedeutung: E71) |
| E35 | Personen ohne Judopass ändert der Verein direkt |
| E36 | Der Landesverband kann Judopass-Daten im Ausnahmefall weiter direkt ändern (neuer Aztec-Code, protokolliert) |
| E37 | Der Landesverband kann Mitglieder löschen und Dubletten zusammenführen |
| E38 | Die Erst-Erteilung des Judopasses läuft als Antrag über die Eingangsbox des Landesverbands |
| E44 | Module zur nächsten Graduierung werden einzeln abgelegt (Abnahme je Grad durch Kyu-Prüfer, Kreis-Dan-Vorsitzenden oder Dan-Prüfer); der Gürtel wird erst vergeben, wenn alle Module bestanden sind |
| E46 | Module verfallen nicht und bleiben auch bei einer neuen Prüfungsordnung erhalten |
| E47 | Wartezeit und Mindestalter prüft der Server; Module dürfen vor Ablauf der Wartezeit abgelegt werden |
| E49 | Das Mindestalter gilt nur für die Graduierung, nicht für Module |
| E63 | Der Judopass bleibt beim Wechsel in einen anderen Landesverband gültig; die nächste Verlängerung läuft über den neuen Landesverband |
| E67 | Lizenzen, Dokumente und Passfoto hängen an der Person (Passfoto am Judopass); auch Nachweise wie das Führungszeugnis sind Lizenzen der Person |
| E70 | Es gibt keine Personensuche, auch nicht über die Judopass-Nr.; eine weitere Mitgliedschaft wird beantragt, mit Pass-Nr. (falls vorhanden); der Antrag überträgt nie den Pass, dafür ist danach ein Transfer nötig |
| E71 | Der Heimatverein hängt an der Person und ist der Verein, bei dem der Judopass liegt; ohne Transfer bleibt er es auch nach Austritt oder Kündigung |
| E72 | Judopass-Antrag, Verlängerungsantrag (gegen Jahressichtmarke, Freigabe durch den Landesverband) und Zahlungsweise gegenüber dem Landesverband liegen beim Verein |
| E73 | Transfer in zwei Arten: Vereinswechsel (alte Mitgliedschaft endet) und Heimatwechsel (Person bleibt in beiden Vereinen, nur Pass/Heimatverein wechselt); die Person bittet den Verein mit dem Pass, ihn einzuleiten; auch ruhende oder ausgetretene Mitglieder sind transferierbar, B nutzt eine vorhandene Mitgliedschaft oder legt eine neue an |
| E74 | Dan-Prüfungen legt der Bezirks-Dan-Beauftragte an, zusätzlich die Rolle Dan-Prüfungsorganisation im Landesverband |
| E75 | Mit 18 ruht der Elternzugriff; das Kind schaltet ihn bei der Anmeldung jeweils für ein Jahr frei und kann ihn jederzeit beenden |
| E76 | Jedes Mitglied wird automatisch mit dem 9. Kyu angelegt (ohne Prüfung und Gebühr); der Kyu-Prüfer prüft 8.–2. Kyu |
| E79 | Löschen, Zusammenführen und Judopass-Daten nur durch den Landesverband des Heimatvereins |
| E81 | Der Heimatverein braucht keine aktive Mitgliedschaft; ohne Transfer bleiben Pass und Person beim Verein. Gibt es den Verein nicht mehr, überträgt der Landesverband die Person an einen neuen Verein |
| E82 | Je Person bzw. Pass höchstens ein offener Transfer |
| E83 | Die Mitgliedsnummer im neuen Verein erzeugt der Server bei Anlage bzw. Transfer |
| E84 | Das Führungszeugnis ist eine Lizenz der Person mit Sonderregeln nach § 72a SGB VIII (nur Einsichtnahme, Löschfrist, nicht im Abgleich) |
| E86 | Eltern dürfen Dritten nur Lesezugriff auf ihr Kind geben; Änderungsrechte vergibt nur der Heimatverein |
| E89 | Dan-Prüfer nehmen bis einschließlich zum eigenen Grad ab (bestätigt E8) |
| E97 | Ein Benutzer kann in einem Verein mehrere Rollen haben (`benutzer_vereinsrollen`); die Rechte addieren sich |
| E98 | Vereinseigene Rollen legt der Vereins-Admin an, nur mit Rechten aus einer Positivliste der Vereinsebene und höchstens mit Operationen, die er selbst delegieren darf |
| E99 | Mit dem Austritt (ohne weitere Mitgliedschaft im Verein) enden Vereinsrollen und vereinsbezogene Direktrechte automatisch |
| E100 | Ein Online-Mitgliedschaftsantrag ohne Pass-Nr. übernimmt die Person aus dem Konto der Person bzw. der Eltern; Dubletten über Landesverbandsgrenzen führt der Landesverband des Heimatvereins der älteren Zeile zusammen |
| E101 | Jeder Verein hängt an einem Kreis (Struktur DJB › Landesverband › Bezirk › Kreis › Verein) |
| E102 | Delegierte Rechte haben immer ein Enddatum (höchstens zwei Jahre) |
| E103 | Zugriff nach 4.4 nur bei bekanntem Geburtsdatum; Vormund bzw. Betreuung mit Nachweis ruht ab 18 nicht; eigenes Konto erst ab 14 |
| E104 | Lizenzen wirken auch im Vereinskontext, wenn der Verein im Bereich der Lizenz liegt |
| E105 | Kyu-Prüfer legen Kyu-Prüfungen im Verein an, führen sie durch und schließen sie ab; Trainer dürfen sie im Verein nur anlegen; Kreis-Dan-Vorsitzende nehmen Prüfungen zum 1. Kyu im Kreis ab; Dan-Prüfer nehmen Dan-Prüfungen im Landesverband ab |
| E106 | Migration mit Zuordnungstabelle alt → neu und Konfliktliste auch für Treffer über Name und Geburtsdatum; `/v2/abgleich` läuft parallel zu `/v1/abgleich` |
| E107 | Der Bezirks-Dan-Beauftragte sieht Personen ab 1. Kyu; `pruefung:LESEN` schließt die Kerndaten der Teilnehmer ein |

---

## 16. Annahmen

Vom Nutzer am 2026-11-20 durchgesehen. Ersetzte Annahmen sind entfernt; ihre Nummern werden nicht neu vergeben.

1. `personen`-Tabelle wird eingeführt (nötig für Transfer und Heimatverein).
3. Rechte eines Verbands gelten für den gesamten Teilbaum darunter.
4. Bezirks-Dan-Beauftragter ist eine Rolle, keine Lizenz.
5. Der Landesverbands-Admin wird vom DJB-Admin bzw. Super-Admin vergeben.
6. Kontaktdaten dürfen Heimatverein, Person selbst (ab 14) und Berechtigte ändern; andere Vereine lesen sie nur.
8. Je Saison höchstens ein Einzelstartrecht; Mannschaftsstartrechte ohne feste Obergrenze.
9. Der aufnehmende Verein muss einen Transfer annehmen.
10. Code-Inhalt wird zusätzlich signiert; Judopass-Nr. und Gültigkeit stehen mit im Aztec-Code.
11. Judopass-Anträge stellt nur der Heimatverein; zuständig ist dessen Landesverband.
15. Ist das letzte Modul vor Ende der Wartezeit bestanden, entsteht die Graduierung automatisch am Tag, an dem die Wartezeit endet.
26. Die Zuordnung Pass-Nr. → Person verlangt zusätzlich Nachname und Geburtsdatum.
