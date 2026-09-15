# Examples

Real examples for the Claude Code skills of the `govdata` plugin, one per skill: a request,
the `govdata` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `govdata` 0.0.6.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [govdata-catalogue-stats](#govdata-catalogue-stats) · [govdata-dataset-finder](#govdata-dataset-finder) · [govdata-resource-harvest](#govdata-resource-harvest)

## govdata-catalogue-stats

> Who publishes the most open datasets about Radverkehr on GovData, and in which file formats?

```bash
govdata --compact action package_search --param rows=0                       # catalogue total
govdata --compact action package_search --param q=Radverkehr --param rows=0 --param 'facet.field=["organization","res_format"]' --param 'facet.limit=50'
govdata --compact action package_search --param q=Radverkehr --param rows=0 --param 'facet.field=["res_format","license_id"]' --param 'facet.limit=200'   # res_format hit the 50 cap
govdata --compact action package_search --param q=Radverkehr --param rows=0 --param 'fq=res_format:("JSON" OR "http://publications.europa.eu/resource/authority/file-type/JSON")'
```

The publisher facet came back unsorted, so the skill sorted it by count. The format facet returned
exactly 50 values, which meant it was cut off, so the skill re-ran it with a higher limit (56 values).
It then merged each plain format name with its EU-URI twin, e.g. `CSV` (1) + `…/file-type/CSV` (72).
Facet counts are datasets, not files. An OR filter found 41 datasets with JSON, while the merged sum
says 42, so one dataset carries both variants.

```
"Radverkehr": 246 of 156 095 datasets in the catalogue. All 15 publishers:

  Mobilithek                      68
  Open.NRW                        45
  Open Data Baden-Württemberg     37
  GDI-DE                          24
  Transparenzportal Hamburg       17
  Open Data Brandenburg           16
  Freistaat Sachsen               13
  open.bydata                      7
  … 7 more: Land Rheinland-Pfalz 5, Land Sachsen-Anhalt 4, Open Data Hessen 3, Berlin Open Data 3,
    Land Brandenburg 2, Stadt Oldenburg (Oldb) 1, Metropolregion Rhein-Neckar 1

Datasets carrying each format (plain and URI variants merged: 56 raw values → 46):

  HTML       78  ████████████
  CSV        73  ███████████
  JSON       42  ██████
  GEOJSON    37  ██████
  WMS_SRVC   34  █████      (another 16 datasets are tagged plain "WMS")
  GML        28  ████
  WFS_SRVC   27  ████       (another 13 "WFS")
  XML        25  ████
  KML        21  ███
  SHP        19  ███        (another 13 "Shape", 5 "Shapefiles")
  … 36 more, down to single datasets (MQTT, ODS, PNG, TXT …)

Licences: the package-level licence facet has a single entry. Only 2 of 246 datasets carry
"Datenlizenz Deutschland – Zero – Version 2.0" there. Read licences per resource instead.
```

Next steps offered: narrow the breakdown to one publisher (`--param fq=organization:mcloud`), or list the
datasets themselves with govdata-dataset-finder.

## govdata-dataset-finder

> Is there downloadable CSV data from bicycle counting stations (Fahrradzählstellen)? Freshest first.

```bash
govdata --compact search "Fahrradzählstellen" --rows 25 --sort "metadata_modified desc"
govdata --compact package fahrrad-zahlstellen-zeitreihe          # full record for one hit
```

All 17 hits fit on one page. Every hit had an empty `license_id` and `isopen: false`, so licences were
read from `resources[].license`. The Munich series appeared four times across two portals (2024 through
open.bydata, 2025, 2026 and a yearly archive through Mobilithek) and was merged into one entry.
Münster's district counters offer only XLS/XLSX, so they rank below the CSV datasets.

```
"Fahrradzählstellen": 17 datasets in the catalogue. CSV first, then by last update:

1. Daten der Raddauerzählstellen München (2024–2026 + archive 2008–2025)   Landeshauptstadt München
   CSV · updated 2026-09-15 · DL-DE-BY 2.0 · 2026 edition: 14 files, 15-minute and daily values with weather, Jan–Jul
   → govdata package daten-der-raddauerzahlstellen-munchen-2026  (also …-2025, …-2024-1, …-jahreszahlen9524e)
2. Gebündelte Daten Eco-Counter Fahrradzählstellen Baden-Württemberg       MobiData BW
   CSV, JSON, XLSX, PDF · updated 2026-09-15 · DL-DE-BY 2.0 · 17 resources (2 API entries have no URL)
   → govdata package gebundelte-daten-eco-counter-fahrradzahlstellen-baden-wurttemberg1549c
3. Verkehrszählung Fahrradverkehr: Tagesaktuelle Daten                      Stadt Münster
   CSV ("Git-Repository mit den tagesaktuellen CSV-Dateien", a link, not a file) · updated 2026-09-11 · CC BY 3.0 DE
   → govdata package verkehrszahlung-fahrradverkehr-tagesaktuelle-datenffaff
4. Fahrrad-Zählstellen Zeitreihe                                            Stadt Freiburg i. Br.
   CSV · updated 2026-07-17 · DL-DE-BY 2.0 · 1 file
   → govdata package fahrrad-zahlstellen-zeitreihe
5. Radfahrende nach Zählstellen                   Statistisches Amt der Landeshauptstadt Stuttgart
   CSV, XLSX · updated 2026-04-16 · CC BY 4.0 · 2 files
   → govdata package radfahrende-nach-zahlstellen
6. Fahrradzählstellen in Heidelberg                                         Stadt Heidelberg
   CSV, JSON (incl. real-time API) · updated 2025-10-29 · CC0 · 21 files
   → govdata package fahrradzahlstellen-in-heidelberg938f4

No CSV: Verkehrszählung Fahrradverkehr, 5 Münster district datasets (XLS/XLSX, 8–32 files each,
updated 2026-09-11; DL-DE-BY 2.0, older years "other-closed"), plus counter locations as GeoJSON.
Also matched: Verkehrskameras in Heidelberg, Verkehrszählung - Fahrradverkehr 2019 (Münster).
```

Next steps offered: the direct download URLs, or a CSV manifest of the Munich files through govdata-resource-harvest.

## govdata-resource-harvest

> Collect the GeoJSON files of public drinking-water fountains (Trinkwasserbrunnen) into a list I can load into a map, and download a couple of small ones.

```bash
govdata --compact search "Trinkwasserbrunnen" --rows 50 --sort "metadata_modified desc"
# flatten resources[] with jq, keep format tail == GEOJSON → trinkbrunnen-manifest.tsv
curl -sS -L --max-filesize 2000000 --max-time 30 -o trinkwasserspender-rostock.json https://geo.sv.rostock.de/download/opendata/trinkwasserspender/trinkwasserspender.json
curl -sS -L --max-filesize 2000000 --max-time 30 -o trinkbrunnen-moers.geojson https://geoportal-niederrhein.de/lgv-config/geojson/moers/Trinkbrunnen.geojson
```

The full-text search also returned unrelated datasets (Ingolstadt soil-moisture sensors, Augsburg bike
service points). The one unrelated GeoJSON among them was dropped. Nine WMS/WFS/OAF service endpoints
were left out. Only one file states its size, so both downloads were capped at 2 MB.

```
Trinkwasserbrunnen · GeoJSON harvest: 24 datasets scanned (85 resources), 9 GeoJSON files in 8 datasets

trinkwasserbrunnen-stadt-ingolstadt (Stadt Ingolstadt) · CC BY 4.0
  Standorte Trinkwasserbrunnen - GeoJSON      ?  https://www.ingolstadt.de/openbydata/GIS/Trinkwasserbrunnen_Ingolstadt.geojson
trinkbrunnen-stadt-moers (Stadt Moers) · DL-DE Zero 2.0
  GeoJSON - Trinkbrunnen (Stadt Moers)        ?  https://geoportal-niederrhein.de/lgv-config/geojson/moers/Trinkbrunnen.geojson
trinkwasserbrunnen6a2dc (Stadt Dortmund) · DL-DE Zero 2.0 (given as a govdata.de URI)
  geojson                                     ?  https://open-data.dortmund.de/api/v2/catalog/datasets/trinkwasserbrunnen/exports/geojson
trinkwasserbrunnen-wuppertal02be6 (Stadt Wuppertal) · CC BY 4.0
  … WGS84 Länge/Breite, GeoJSON               ?  https://daten.wuppertal.de/Umwelt_Klima/Trinkwasserbrunnen_EPSG4326_JSON.json
  … ETRS89/UTM32, GeoJSON (not WGS84)         ?  https://daten.wuppertal.de/Umwelt_Klima/Trinkwasserbrunnen_EPSG25832_JSON.json
kreis-herford-offentliche-trinkwasserbrunnend17dc (Kreis Herford) · DL-DE-BY 2.0
  GeoJSON                                     ?  https://geoportal.kreis-herford.de/geoviewer/geodata/klimaschutz/trinkwasser_osm_4326.geojson
stadtplan-der-stadtischen-trinkbrunnen21a4d (Landeshauptstadt München) · DL-DE-BY 2.0
  WFS (GeoJSON), a live WFS query            ?  https://geoportal.muenchen.de/geoserver/baug_wfs/ows?service=WFS&…&outputFormat=application/json
trinkwasserbrunnen (Hanse- und Universitätsstadt Rostock) · CC0
  Trinkwasserspender                      826 B  https://geo.sv.rostock.de/download/opendata/trinkwasserspender/trinkwasserspender.json
trinkwasserbrunnen-in-augsburg (Stadt Augsburg) · CC BY 4.0
  Name und geograpische Verortung von Trinkwasserbrunnen in Augsburg  ?  https://www.augsburg.de/…/opendata/Trinkwasserbrunnen.geojson

Wrote trinkbrunnen-manifest.tsv: 9 rows (dataset, publisher, file, format, size, licence, url)
Downloaded 2 files (both openly licensed):
  trinkwasserspender-rostock.json   826 B  FeatureCollection, 3 Point features
  trinkbrunnen-moers.geojson       1299 B  FeatureCollection, 3 Point features
```

Next steps offered: a `urls.txt` for `wget -i`, or the same harvest for CSV.
