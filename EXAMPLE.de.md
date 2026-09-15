# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `govdata`, eines pro Skill: eine
Anfrage, die `govdata`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `govdata` 0.0.6 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [govdata-catalogue-stats](#govdata-catalogue-stats) · [govdata-dataset-finder](#govdata-dataset-finder) · [govdata-resource-harvest](#govdata-resource-harvest)

## govdata-catalogue-stats

> Wer veröffentlicht auf GovData die meisten offenen Datensätze zum Radverkehr, und in welchen Dateiformaten?

```bash
govdata --compact action package_search --param rows=0                       # Gesamtzahl im Katalog
govdata --compact action package_search --param q=Radverkehr --param rows=0 --param 'facet.field=["organization","res_format"]' --param 'facet.limit=50'
govdata --compact action package_search --param q=Radverkehr --param rows=0 --param 'facet.field=["res_format","license_id"]' --param 'facet.limit=200'   # res_format stieß an die Grenze von 50
govdata --compact action package_search --param q=Radverkehr --param rows=0 --param 'fq=res_format:("JSON" OR "http://publications.europa.eu/resource/authority/file-type/JSON")'
```

Die Facette für Herausgeber kam unsortiert zurück, der Skill hat sie deshalb nach Anzahl sortiert. Die
Formatfacette lieferte genau 50 Werte, war also abgeschnitten. Der Skill hat sie mit höherem Limit neu
abgefragt (56 Werte) und dann jeden einfachen Formatnamen mit seinem EU-URI-Gegenstück zusammengeführt,
z. B. `CSV` (1) + `…/file-type/CSV` (72). Facettenzahlen zählen Datensätze, nicht Dateien: Ein OR-Filter
ergab 41 Datensätze mit JSON, die Summe dagegen 42 – ein Datensatz trägt beide Varianten.

```
„Radverkehr": 246 von 156.095 Datensätzen im Katalog. Alle 15 Herausgeber:

  Mobilithek                      68
  Open.NRW                        45
  Open Data Baden-Württemberg     37
  GDI-DE                          24
  Transparenzportal Hamburg       17
  Open Data Brandenburg           16
  Freistaat Sachsen               13
  open.bydata                      7
  … 7 weitere: Land Rheinland-Pfalz 5, Land Sachsen-Anhalt 4, Open Data Hessen 3, Berlin Open Data 3,
    Land Brandenburg 2, Stadt Oldenburg (Oldb) 1, Metropolregion Rhein-Neckar 1

Datensätze je Format (einfache und URI-Varianten zusammengeführt: 56 Rohwerte → 46):

  HTML       78  ████████████
  CSV        73  ███████████
  JSON       42  ██████
  GEOJSON    37  ██████
  WMS_SRVC   34  █████      (weitere 16 Datensätze nur mit „WMS" gekennzeichnet)
  GML        28  ████
  WFS_SRVC   27  ████       (weitere 13 „WFS")
  XML        25  ████
  KML        21  ███
  SHP        19  ███        (weitere 13 „Shape", 5 „Shapefiles")
  … 36 weitere, bis hin zu einzelnen Datensätzen (MQTT, ODS, PNG, TXT …)

Lizenzen: Die Lizenzfacette auf Paketebene hat nur einen Eintrag. Lediglich 2 von 246 Datensätzen
tragen dort „Datenlizenz Deutschland – Zero – Version 2.0". Lizenzen besser je Ressource lesen.
```

Als Nächstes angeboten: die Auswertung auf einen Herausgeber eingrenzen (`--param fq=organization:mcloud`)
oder die Datensätze selbst mit govdata-dataset-finder auflisten.

## govdata-dataset-finder

> Gibt es CSV-Daten von Fahrradzählstellen zum Herunterladen? Die aktuellsten zuerst.

```bash
govdata --compact search "Fahrradzählstellen" --rows 25 --sort "metadata_modified desc"
govdata --compact package fahrrad-zahlstellen-zeitreihe          # vollständiger Datensatz zu einem Treffer
```

Alle 17 Treffer passten auf eine Seite. Bei jedem Treffer war `license_id` leer und `isopen: false`,
deshalb stammen die Lizenzen aus `resources[].license`. Die Münchner Reihe tauchte viermal über zwei
Portale auf (2024 über open.bydata; 2025, 2026 und ein Jahresarchiv über Mobilithek) und wurde zu einem
Eintrag zusammengefasst. Die Münsteraner Zählstellen gibt es nur als XLS/XLSX, sie stehen daher hinter
den CSV-Datensätzen.

```
„Fahrradzählstellen": 17 Datensätze im Katalog. Erst CSV, dann nach letzter Aktualisierung:

1. Daten der Raddauerzählstellen München (2024–2026 + Archiv 2008–2025)    Landeshauptstadt München
   CSV · aktualisiert 2026-09-15 · DL-DE-BY 2.0 · Ausgabe 2026: 14 Dateien, 15-Minuten- und Tageswerte mit Wetter, Jan.–Juli
   → govdata package daten-der-raddauerzahlstellen-munchen-2026  (auch …-2025, …-2024-1, …-jahreszahlen9524e)
2. Gebündelte Daten Eco-Counter Fahrradzählstellen Baden-Württemberg       MobiData BW
   CSV, JSON, XLSX, PDF · aktualisiert 2026-09-15 · DL-DE-BY 2.0 · 17 Ressourcen (2 API-Einträge ohne URL)
   → govdata package gebundelte-daten-eco-counter-fahrradzahlstellen-baden-wurttemberg1549c
3. Verkehrszählung Fahrradverkehr: Tagesaktuelle Daten                      Stadt Münster
   CSV („Git-Repository mit den tagesaktuellen CSV-Dateien" – ein Link, keine Datei) · aktualisiert 2026-09-11 · CC BY 3.0 DE
   → govdata package verkehrszahlung-fahrradverkehr-tagesaktuelle-datenffaff
4. Fahrrad-Zählstellen Zeitreihe                                            Stadt Freiburg i. Br.
   CSV · aktualisiert 2026-07-17 · DL-DE-BY 2.0 · 1 Datei
   → govdata package fahrrad-zahlstellen-zeitreihe
5. Radfahrende nach Zählstellen                   Statistisches Amt der Landeshauptstadt Stuttgart
   CSV, XLSX · aktualisiert 2026-04-16 · CC BY 4.0 · 2 Dateien
   → govdata package radfahrende-nach-zahlstellen
6. Fahrradzählstellen in Heidelberg                                         Stadt Heidelberg
   CSV, JSON (inkl. Echtzeit-API) · aktualisiert 2025-10-29 · CC0 · 21 Dateien
   → govdata package fahrradzahlstellen-in-heidelberg938f4

Ohne CSV: Verkehrszählung Fahrradverkehr, 5 Datensätze zu Münsteraner Stadtteilen (XLS/XLSX, je 8–32
Dateien, aktualisiert 2026-09-11; DL-DE-BY 2.0, ältere Jahre „other-closed"), dazu Zählstellen als GeoJSON.
Ebenfalls gefunden: Verkehrskameras in Heidelberg, Verkehrszählung - Fahrradverkehr 2019 (Münster).
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

Die Volltextsuche lieferte auch fremde Datensätze (Bodenfeuchte-Sensoren in Ingolstadt, Fahrrad-Servicepunkte
in Augsburg). Die eine fremde GeoJSON-Datei darunter wurde verworfen. Neun WMS-/WFS-/OAF-Dienste blieben
außen vor. Nur eine Datei nennt ihre Größe, daher waren beide Downloads auf 2 MB begrenzt.

```
Trinkwasserbrunnen · GeoJSON-Harvest: 24 Datensätze durchsucht (85 Ressourcen), 9 GeoJSON-Dateien in 8 Datensätzen

trinkwasserbrunnen-stadt-ingolstadt (Stadt Ingolstadt) · CC BY 4.0
  Standorte Trinkwasserbrunnen - GeoJSON      ?  https://www.ingolstadt.de/openbydata/GIS/Trinkwasserbrunnen_Ingolstadt.geojson
trinkbrunnen-stadt-moers (Stadt Moers) · DL-DE Zero 2.0
  GeoJSON - Trinkbrunnen (Stadt Moers)        ?  https://geoportal-niederrhein.de/lgv-config/geojson/moers/Trinkbrunnen.geojson
trinkwasserbrunnen6a2dc (Stadt Dortmund) · DL-DE Zero 2.0 (als govdata.de-URI angegeben)
  geojson                                     ?  https://open-data.dortmund.de/api/v2/catalog/datasets/trinkwasserbrunnen/exports/geojson
trinkwasserbrunnen-wuppertal02be6 (Stadt Wuppertal) · CC BY 4.0
  … WGS84 Länge/Breite, GeoJSON               ?  https://daten.wuppertal.de/Umwelt_Klima/Trinkwasserbrunnen_EPSG4326_JSON.json
  … ETRS89/UTM32, GeoJSON (nicht WGS84)       ?  https://daten.wuppertal.de/Umwelt_Klima/Trinkwasserbrunnen_EPSG25832_JSON.json
kreis-herford-offentliche-trinkwasserbrunnend17dc (Kreis Herford) · DL-DE-BY 2.0
  GeoJSON                                     ?  https://geoportal.kreis-herford.de/geoviewer/geodata/klimaschutz/trinkwasser_osm_4326.geojson
stadtplan-der-stadtischen-trinkbrunnen21a4d (Landeshauptstadt München) · DL-DE-BY 2.0
  WFS (GeoJSON), eine Live-WFS-Abfrage       ?  https://geoportal.muenchen.de/geoserver/baug_wfs/ows?service=WFS&…&outputFormat=application/json
trinkwasserbrunnen (Hanse- und Universitätsstadt Rostock) · CC0
  Trinkwasserspender                      826 B  https://geo.sv.rostock.de/download/opendata/trinkwasserspender/trinkwasserspender.json
trinkwasserbrunnen-in-augsburg (Stadt Augsburg) · CC BY 4.0
  Name und geograpische Verortung von Trinkwasserbrunnen in Augsburg  ?  https://www.augsburg.de/…/opendata/Trinkwasserbrunnen.geojson

trinkbrunnen-manifest.tsv geschrieben: 9 Zeilen (Datensatz, Herausgeber, Datei, Format, Größe, Lizenz, URL)
2 Dateien heruntergeladen (beide offen lizenziert):
  trinkwasserspender-rostock.json     826 B  FeatureCollection, 3 Point-Features
  trinkbrunnen-moers.geojson        1.299 B  FeatureCollection, 3 Point-Features
```

Als Nächstes angeboten: eine `urls.txt` für `wget -i` oder derselbe Harvest für CSV.
