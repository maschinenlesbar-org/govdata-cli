# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `govdata`, eines pro Skill: eine
Anfrage, die `govdata`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 6. Oktober 2026 mit `govdata` 0.2.0 gegen die Live-API (jeder Aufruf
mit zusätzlichem `--max-retries 0`, um die Live-API wenig zu belasten).
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [govdata-catalogue-stats](#govdata-catalogue-stats) · [govdata-dataset-finder](#govdata-dataset-finder) · [govdata-resource-harvest](#govdata-resource-harvest)

## govdata-catalogue-stats

> Wer veröffentlicht auf GovData die meisten offenen Datensätze zum Radverkehr, und in welchen Dateiformaten?

```bash
govdata --compact action package_search --param rows=0                       # Gesamtzahl im Katalog
govdata --compact action package_search --param q=Radverkehr --param rows=0 --param 'facet.field=["organization"]' --param 'facet.limit=50'
govdata --compact action package_search --param q=Radverkehr --param rows=0 --param 'facet.field=["res_format","license_id"]' --param 'facet.limit=-1'
govdata --compact search Radverkehr --rows 0 --fq 'res_format:("JSON" OR "http://publications.europa.eu/resource/authority/file-type/JSON")'
govdata --compact search Radverkehr --rows 0 --fq 'res_format:("CSV" OR "http://publications.europa.eu/resource/authority/file-type/CSV")'
```

Die Facette für Herausgeber lieferte 14 Werte, deutlich unter ihrem Limit von 50, war also vollständig;
sie kam unsortiert zurück, der Skill hat sie deshalb nach Anzahl sortiert. Formate und Lizenzen wurden mit
`facet.limit=-1` (alle Werte) abgefragt, weil sie zusammengeführt werden müssen: Aus 57 Formatrohwerten
wurden 41, nachdem jeder einfache Name mit seinem EU-URI-Gegenstück zusammengeführt wurde, z. B. `CSV` (13)
+ `…/file-type/CSV` (69), und `_SRVC` entfiel. Freitextvarianten (`Shape`, `Shapefiles`) kamen von Hand
dazu. Facettenzahlen zählen Datensätze, nicht Dateien. Zusammengeführte Summen sind eine Obergrenze, daher
wurden die beiden größten Datenformate mit einem OR-Filter geprüft: 82 Datensätze mit CSV und 41 mit JSON,
genau die Summen – hier trägt also kein Datensatz beide Varianten.

```
„Radverkehr": 262 von 168.808 Datensätzen im Katalog. Alle 14 Herausgeber:

  Mobilithek                     109
  Open.NRW                        54
  Open Data Baden-Württemberg     21
  Transparenzportal Hamburg       17
  Open Data Brandenburg           16
  Freistaat Sachsen               13
  GDI-DE                           9
  open.bydata                      6
  … 6 weitere: Land Rheinland-Pfalz 5, Land Sachsen-Anhalt 4, Open Data Hessen 3,
    Land Brandenburg 2, Berlin Open Data 2, Metropolregion Rhein-Neckar 1

Datensätze je Format (einfache und URI-Varianten zusammengeführt: 57 Rohwerte → 41):

  CSV        82  █████████████
  HTML       79  ████████████
  WMS        49  ████████    (33 WMS_SRVC + 16 einfach „WMS")
  GEOJSON    42  ███████
  JSON       41  ██████
  WFS        39  ██████      (26 WFS_SRVC + 13 einfach „WFS")
  GML        28  ████
  BIN        27  ████
  XML        25  ████
  KML        22  ███
  SHP        19  ███         (weitere 13 „Shape", 5 „Shapefiles")
  … 26 weitere, bis hin zu einzelnen Datensätzen (MQTT, ODS, PNG, TXT …)
  Kein Format: 30 Datensätze sind mit „download"/„Download" gekennzeichnet.

Lizenzen: Die Lizenzfacette auf Paketebene hat nur einen Eintrag. Lediglich 2 von 262 Datensätzen
tragen dort „Datenlizenz Deutschland – Zero – Version 2.0". Lizenzen besser je Ressource lesen.
```

Als Nächstes angeboten: die Auswertung auf einen Herausgeber eingrenzen (`--param fq=organization:mcloud`)
oder die Datensätze selbst mit govdata-dataset-finder auflisten.

## govdata-dataset-finder

> Gibt es CSV-Daten von Fahrradzählstellen zum Herunterladen? Die aktuellsten zuerst.

```bash
govdata --compact search "Fahrradzählstellen" --rows 25 --sort "metadata_modified desc"
govdata --compact package daten-der-raddauerzahlstellen-munchen-2026     # vollständiger Datensatz zu einem Treffer
```

Alle 16 Treffer passten auf eine Seite. Bei jedem Treffer war `license_id` leer und `isopen: false`,
deshalb stammen die Lizenzen aus `resources[].license`. Die Münchner Reihe tauchte viermal über zwei
Portale auf (2024 über open.bydata; 2025, 2026 und ein Jahresarchiv über Mobilithek) und wurde zu einem
Eintrag zusammengefasst. Münsters tagesaktuelle CSV-Daten sind als Link angegeben, den der Harvester
mitten in der UUID abgeschnitten hat; der Skill markiert ihn deshalb, statt ihn Download zu nennen. Die
Münsteraner Stadtteil-Zählstellen gibt es nur als XLS/XLSX, sie stehen daher hinter den CSV-Datensätzen.

```
„Fahrradzählstellen": 16 Datensätze im Katalog. Erst CSV, dann nach letzter Aktualisierung:

1. Daten der Raddauerzählstellen München (2024–2026 + Archiv 2008–2025)    Landeshauptstadt München
   CSV · aktualisiert 2026-10-05 · DL-DE-BY 2.0 · Ausgabe 2026: 14 Dateien, 15-Minuten- und Tageswerte mit Wetter, Jan.–Juli
   → govdata package daten-der-raddauerzahlstellen-munchen-2026  (auch …-2025, …-2024-1, …-jahreszahlen9524e)
2. Gebündelte Daten Eco-Counter Fahrradzählstellen Baden-Württemberg       MobiData BW
   CSV, JSON, XLSX, PDF · aktualisiert 2026-10-05 · DL-DE-BY 2.0 · 17 Ressourcen (2 ohne URL; manche URLs
   sind Vorlagen mit Platzhalter {yyyymm})
   → govdata package gebundelte-daten-eco-counter-fahrradzahlstellen-baden-wurttemberg9995b
3. Fahrradzählstellen in Heidelberg                         Stadt Heidelberg, Amt für Mobilität
   CSV, JSON (das JSON ist ein API-Aufruf mit api-key in der URL) · aktualisiert 2026-10-05 · CC0 · 21 Ressourcen
   → govdata package fahrradzahlstellen-in-heidelberg
4. Verkehrszählung Fahrradverkehr: Tagesaktuelle Daten                      Stadt Münster
   CSV („Git-Repository mit den tagesaktuellen CSV-Dateien"; der Link ist abgeschnitten, siehe Quellportal)
   · aktualisiert 2026-10-05 · CC BY 3.0 DE
   → govdata package verkehrszahlung-fahrradverkehr-tagesaktuelle-datenffaff
5. Radfahrende an den Zählstellen in Stuttgart seit 2013                    Statistisches Amt Stuttgart
   CSV, XLSX · aktualisiert 2026-09-17 · CC BY 4.0 · 2 Dateien
   → govdata package radfahrende-nach-zahlstellen
6. Fahrrad-Zählstellen Zeitreihe                                            Stadt Freiburg i. Br.
   CSV · aktualisiert 2026-07-17 · DL-DE-BY 2.0 · 1 Datei
   → govdata package fahrrad-zahlstellen-zeitreihe

Ohne CSV: 5 Datensätze zu Münsteraner Stadtteilen (XLS/XLSX, je 8–32 Dateien, aktualisiert 2026-10-03/05;
DL-DE-BY 2.0, ältere Jahre „other-closed"), dazu die Zählstellen-Standorte als GeoJSON.
Ebenfalls gefunden: Verkehrszählung - Fahrradverkehr 2019 (Münster; HTML, XLSX, ZIP; „other-closed").
```

Als Nächstes angeboten: die direkten Download-URLs oder ein CSV-Manifest der Münchner Dateien über govdata-resource-harvest.

## govdata-resource-harvest

> Die GeoJSON-Dateien öffentlicher Trinkwasserbrunnen als Liste zusammenstellen, die sich in eine Karte laden lässt, und ein paar kleine davon herunterladen.

```bash
govdata --compact search "Trinkwasserbrunnen" --rows 50 --sort "metadata_modified desc"
# resources[] mit jq aufklappen, Formatende == GEOJSON behalten → trinkbrunnen-manifest.tsv
curl -sS -L --max-filesize 2000000 --max-time 30 -o trinkwasserspender-rostock.json https://geo.sv.rostock.de/download/opendata/trinkwasserspender/trinkwasserspender.json
curl -sS -L --max-filesize 2000000 --max-time 30 -o trinkbrunnen-moers.geojson https://geoportal-niederrhein.de/lgv-config/geojson/moers/Trinkbrunnen.geojson
```

Die Volltextsuche lieferte auch Datensätze, die nicht von Trinkbrunnen handeln (Bodenfeuchte-Sensoren und
Wetterstationen in Ingolstadt, Fahrrad-Servicepunkte in Augsburg, der Krefelder Fahrradstadtplan als PDF).
Die eine solche GeoJSON-Datei (Augsburgs Servicepunkte) wurde verworfen. Neun WMS-/WFS-/OAF-Dienste blieben
außen vor. Nur eine Datei nennt ihre Größe, daher waren beide Downloads auf 2 MB begrenzt.

```
Trinkwasserbrunnen · GeoJSON-Harvest: 27 Datensätze durchsucht (106 Ressourcen), 9 GeoJSON-Dateien in 8 Datensätzen

trinkwasserbrunnen6a2dc (Stadt Dortmund) · DL-DE Zero 2.0 (als govdata.de-URI angegeben)
  geojson                                     ?  https://open-data.dortmund.de/api/v2/catalog/datasets/trinkwasserbrunnen/exports/geojson
trinkbrunnen-stadt-moerse700d (Stadt Moers) · DL-DE Zero 2.0
  GeoJSON - Trinkbrunnen (Stadt Moers)        ?  https://geoportal-niederrhein.de/lgv-config/geojson/moers/Trinkbrunnen.geojson
kreis-herford-offentliche-trinkwasserbrunnen12af7 (Kreis Herford) · DL-DE-BY 2.0
  GeoJSON                                     ?  https://geoportal.kreis-herford.de/geoviewer/geodata/klimaschutz/trinkwasser_osm_4326.geojson
trinkwasserbrunnen-stadt-ingolstadt (Stadt Ingolstadt) · CC BY 4.0
  Standorte Trinkwasserbrunnen - GeoJSON      ?  https://www.ingolstadt.de/openbydata/GIS/Trinkwasserbrunnen_Ingolstadt.geojson
trinkwasserbrunnen-wuppertal02be6 (Stadt Wuppertal) · CC BY 4.0
  … WGS84 Länge/Breite, GeoJSON               ?  https://daten.wuppertal.de/Umwelt_Klima/Trinkwasserbrunnen_EPSG4326_JSON.json
  … ETRS89/UTM32, GeoJSON (nicht WGS84)       ?  https://daten.wuppertal.de/Umwelt_Klima/Trinkwasserbrunnen_EPSG25832_JSON.json
stadtplan-der-stadtischen-trinkbrunnen21a4d (Landeshauptstadt München) · DL-DE-BY 2.0
  WFS (GeoJSON), eine Live-WFS-Abfrage       ?  https://geoportal.muenchen.de/geoserver/baug_wfs/ows?service=WFS&…&outputFormat=application/json
trinkwasserbrunnen (Hanse- und Universitätsstadt Rostock) · CC0
  Trinkwasserspender                      826 B  https://geo.sv.rostock.de/download/opendata/trinkwasserspender/trinkwasserspender.json
trinkwasserbrunnen-in-augsburg (Stadt Augsburg) · CC BY 4.0
  Name und geograpische Verortung von Trinkwasserbrunnen in Augsburg  ?  https://www.augsburg.de/…/opendata/Trinkwasserbrunnen.geojson

trinkbrunnen-manifest.tsv geschrieben: 9 Zeilen (Datensatz, Portal, Herausgeber, Datei, Größe, Lizenz, URL)
2 Dateien heruntergeladen (beide offen lizenziert):
  trinkwasserspender-rostock.json     826 B  FeatureCollection, 3 Point-Features
  trinkbrunnen-moers.geojson        1.299 B  FeatureCollection, 3 Point-Features
```

Als Nächstes angeboten: eine `urls.txt` für `wget -i` oder derselbe Harvest für CSV.
