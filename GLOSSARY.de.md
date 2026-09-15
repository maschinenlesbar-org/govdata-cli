# Glossar

Ein Nachschlagewerk für die Fachbegriffe und projektspezifischen Begriffe, die in
`govdata-cli` verwendet werden. Dieses Tool kapselt die **GovData-CKAN-Action-API**
(`ckan.govdata.de`); das Vokabular verteilt sich daher auf das Open-Data-Programm
**GovData**, die Software **CKAN**, auf der der Katalog läuft (samt ihrer Eigenheiten,
z. B. „package“ == „dataset“), und die **projekteigenen** Begriffe von Client und CLI.

---

## Das GovData-Programm

**GovData.** Das zentrale Open-Data-Portal für Deutschland (`govdata.de`), das offene
Datensätze von Bund, Ländern und Kommunen bündelt. Es ist der deutsche Knoten, der das
europäische Portal [data.europa.eu](https://data.europa.eu) speist.

**Open Data.** Daten, die unter einer offenen Lizenz veröffentlicht sind und von allen
genutzt, weiterverwendet und weiterverbreitet werden dürfen. Alles, was dieses Tool
erreicht, ist offen und benötigt keinen API-Schlüssel.

**CKAN.** Die Open-Source-Software für Datenmanagement und Katalogisierung (ursprünglich
von der Open Knowledge Foundation), auf der GovData läuft. Ihre HTTP-Schnittstelle ist
die **Action API**, die dieser Client kapselt.

**DCAT-AP.de.** Das deutsche Anwendungsprofil des W3C-Metadatenstandards **DCAT** (Data
Catalog Vocabulary). Die Metadaten der Datensätze auf GovData folgen ihm; deshalb sind die
Rohfelder eines Datensatzes katalogspezifisch und werden hier als untypisiertes JSON
bereitgestellt.

---

## CKAN-Kernobjekte

**Datensatz (`Package`).** Die grundlegende Katalogeinheit: eine beschriebene Sammlung von
Daten zu einem Thema (Titel, Beschreibung, Herausgeber, Tags, Lizenz und eine oder mehrere
Ressourcen). CKAN nennt einen Datensatz historisch **„package“**, daher heißen die
Action-Namen der API `package_*`, obwohl das Konzept für Nutzende „Datensatz“ ist.
Bereitgestellt als rohes `JsonObject` (`Package`). CLI: `package`, `packages`, `search`.

**Ressource (Distribution / `Resource`).** Eine einzelne bereitgestellte Datei oder ein
Dienst-Endpoint *innerhalb* eines Datensatzes – z. B. eine CSV-, JSON-, XLSX- oder
WMS-URL. Ein Datensatz hat meist mehrere. In DCAT-Begriffen ist eine Ressource eine
*Distribution*. Identifiziert über ihre eigene ID. CLI: `resource <id>`.

**Organisation (`Organization`).** Ein **Herausgeber** von Daten – die Stelle, der
Datensätze gehören und die sie pflegt (z. B. ein statistisches Amt des Bundes).
Organisationen haben in CKAN Mitgliedschafts- und Eigentumssemantik.
CLI: `organizations`, `organization`.

**Gruppe (`Group`).** Eine thematische Gruppierung bzw. **Kategorie** von Datensätzen
(z. B. ein Open-Data-Thema). Anders als einer Organisation gehören einer Gruppe keine
Datensätze; sie ordnet sie ein. CLI: `groups`, `group`.

**Tag.** Ein freies Schlagwort an einem Datensatz, das beim Auffinden hilft. Tags lassen
sich auflisten und nach Teilzeichenketten filtern. CLI: `tags [--query <substring>]`.

**Facette.** Ein Feld, über das CKAN ein Suchergebnis aggregiert, um Häufigkeiten der
Werte zu liefern (z. B. wie viele Treffer je `organization` oder `res_format`). Gezählt
werden **Datensätze**, nicht Ressourcen: Ein Datensatz mit fünf CSV-Dateien zählt einmal.
Angefordert über `facet.field` (in der Bibliothek die Option `facet_field`) und
zurückgegeben unter `facets` / `search_facets` in einem `PackageSearchResult`. Es kommen
nur die obersten `facet.limit` Werte zurück (50, sofern nicht gesetzt; `-1` liefert alle).

---

## Funktionsweise der CKAN-Action-API

**Action API.** Die RPC-artige HTTP-API von CKAN mit der Wurzel `/api/3/action/`. Jeder
Endpoint ist eine **Action**, die über ihren Namen angesprochen wird, z. B.
`package_search`, `package_show`, `organization_list`. Dieser Client nutzt ausschließlich
die offenen, rein lesenden (`GET`) Actions.

**Action-Name.** Der `[a-z0-9_]+`-Bezeichner einer Action. Der Client prüft jeden Namen
gegen `^[a-z0-9_]+$` (und URL-codiert ihn), damit der generische Notausgang keine
zusätzlichen Pfadsegmente, keinen Query-String und kein Fragment in die Request-URL
einschleusen kann.

**CKAN-Hülle (`CkanEnvelope`).** Jede Antwort der Action API ist in
`{ help, success, result }` verpackt (bzw. `{ help, success, error }`, wenn `success`
false ist). `help` ist eine Docstring-URL bzw. ein Docstring-Text, `success` das
Status-Flag, `result` die Nutzdaten. Der Client **packt `result` aus** und löst bei
`success: false` einen Fehler aus.

**`package_search`.** Die Action für Volltext- und facettierte Suche nach Datensätzen.
Liefert ein `PackageSearchResult` (`count`, `results`, `facets`, `search_facets`, `sort`).
CLI: `search`. Parameter: `q`, `fq` / `fq_list`, `rows`, `start`, `sort`, `facet.field`.

**`package_show` / `package_list`.** Einen Datensatz per ID oder Name abrufen; Namen von
Datensätzen mit `limit`/`offset` auflisten. CLI: `package`, `packages`.

**`organization_show` / `organization_list`, `group_show` / `group_list`.**
Eine Organisation bzw. Gruppe anzeigen oder alle auflisten. Die `_list`-Actions liefern
standardmäßig nur **Namen**, mit `all_fields` vollständige Objekte. CLI:
`organization(s)`, `group(s)` (`--all-fields`).

**`tag_list`, `resource_show`.** Tags auflisten (optional mit `query` als
Teilzeichenketten-Filter); eine Ressource per ID anzeigen. CLI: `tags`, `resource`.

**Generische Action (Notausgang).** `client.action(name, params)` bzw. der CLI-Befehl
`action <name> [--param key=value …]` ruft **jede** lesende Action auf – auch solche ohne
typisierte Komfortmethode – und liefert das ausgepackte `result`.

---

## Suchparameter (Solr)

Die CKAN-Suche basiert auf **Apache Solr**, ihre Parameter folgen daher der Solr-Syntax.

**`q` (Suchanfrage).** Der Solr-Query-String, z. B. `title:Haushalt` oder ein einfacher
Begriff. CLI-Positionsargument: `search [query]`. Solr **zerlegt** die Anfrage in Tokens,
ein einfacher Begriff kann also auf ein Teil-Token statt auf die ganze Zeichenkette passen
(z. B. kann `abc12345` einen Titel treffen, der `12345` enthält). Schränken Sie das Feld
ein (`title:…`) oder ergänzen Sie einen `--fq`-Filter, wenn Sie einen genauen Treffer statt
eines losen Stichworts brauchen.

**`fq` (Filterabfrage).** Ein Solr-Filter, der die Ergebnisse einschränkt, ohne die
Relevanzbewertung zu beeinflussen, z. B. `organization:statistisches-bundesamt`,
`groups:tran`. CLI: `--fq` (mehrfach angebbar; jeder Filter muss zutreffen). CKAN lehnt
einen wiederholten `fq`-Schlüssel ab, daher sendet der Client einen einzelnen Filter als
`fq` und mehrere als `fq_list`. CKAN stellt einem `fq` `+capacity:public` voran, deshalb
wirkt ein `OR` auf oberster Ebene innerhalb eines Filters nicht: Schreiben Sie
`(organization:open-nrw OR groups:tran)` statt des bloßen `OR`.

**`rows` / `start`.** Seitengröße und nullbasierter Offset zum Blättern durch
Suchtreffer. CLI: `--rows`, `--start`. Das Solr von GovData **begrenzt `rows` auf 1.000**
je Anfrage; ein größerer Wert liefert also höchstens 1.000 Ergebnisse (wobei `count`
weiterhin die tatsächliche Gesamtzahl meldet). Über die ersten 1.000 hinaus blättern Sie
mit `start`. (Die `*_list`-Actions verwenden stattdessen `limit` / `offset`.)

**`sort`.** Ein Solr-Sortierausdruck, z. B. `metadata_modified desc`. CLI: `--sort`.

**`facet.field`.** Die Felder, für die Facettenzahlen berechnet werden, als JSON-Liste wie
`["res_format"]` (siehe *Facette*). In der Bibliothek heißt die Option `facet_field`; CKAN
selbst lehnt einen Parameter `facet_field` ab.

**`res_format`.** Ein gängiger Facetten- bzw. Filterwert: das Format einer Ressource
(`CSV`, `JSON`, `WMS`, …). Wird innerhalb eines `fq` verwendet, nicht über ein eigenes
Flag. Dasselbe Format erscheint als einfache Zeichenkette und als URI des EU-Dateityp-Vokabulars
(`http://publications.europa.eu/resource/authority/file-type/CSV`); filtern Sie daher auf
beide: `res_format:("CSV" OR "http://publications.europa.eu/resource/authority/file-type/CSV")`.

**`metadata_modified` / `metadata_created`.** Zeitstempelfelder eines Datensatzes; ersteres
ist der übliche Sortierschlüssel für „neueste zuerst“.

---

## Kennungen & Paginierung

**id / name (Slug).** Datensätze, Organisationen und Gruppen lassen sich entweder über ihre
CKAN-**ID** (UUID) oder ihren menschenlesbaren **Namen** (URL-Slug) ansprechen. Die
`*_show`-Actions akzeptieren beides. Ressourcen werden nur per ID angesprochen.

**`limit` / `offset` (`ListParams`).** Paginierung für die `*_list`-Actions: Seitengröße
und Anzahl der zu überspringenden Einträge. (Nicht zu verwechseln mit `rows` / `start` der
Suche.)

**`all_fields`.** Bei `organization_list` / `group_list` vollständige Objekte statt nur
Namen zurückgeben. CLI: `--all-fields`.

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `GovDataClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> Query-Builder – stehen jetzt in **[DEVELOPING.md](DEVELOPING.md)**.
