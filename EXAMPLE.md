# Examples

Real examples for the Claude Code skills of the `govdata` plugin, one per skill: a request,
the `govdata` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026 with `govdata` 0.2.0 (each call with
`--max-retries 0` added, to keep the load on the live API low).
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [govdata-catalogue-stats](#govdata-catalogue-stats) · [govdata-dataset-finder](#govdata-dataset-finder) · [govdata-resource-harvest](#govdata-resource-harvest)

## govdata-catalogue-stats

> Who publishes the most open datasets about Radverkehr on GovData, and in which file formats?

```bash
govdata --compact action package_search --param rows=0                       # catalogue total
govdata --compact action package_search --param q=Radverkehr --param rows=0 --param 'facet.field=["organization"]' --param 'facet.limit=50'
govdata --compact action package_search --param q=Radverkehr --param rows=0 --param 'facet.field=["res_format","license_id"]' --param 'facet.limit=-1'
govdata --compact search Radverkehr --rows 0 --fq 'res_format:("JSON" OR "http://publications.europa.eu/resource/authority/file-type/JSON")'
govdata --compact search Radverkehr --rows 0 --fq 'res_format:("CSV" OR "http://publications.europa.eu/resource/authority/file-type/CSV")'
```

The publisher facet returned 14 values, well under its limit of 50, so it was complete; it came back
unsorted, so the skill sorted it by count. Formats and licences were asked for with `facet.limit=-1`
(all values), since they need folding: 57 raw format values became 41 after merging each plain name
with its EU-URI twin, e.g. `CSV` (13) + `…/file-type/CSV` (69), and dropping `_SRVC`. Free-text
variants (`Shape`, `Shapefiles`) were added by hand. Facet counts are datasets, not files. Folded
sums are an upper bound, so the two biggest data formats were checked with an OR filter: 82 datasets
with CSV and 41 with JSON, the same as the folded sums, so no dataset carries both variants here.

```
"Radverkehr": 262 of 168 808 datasets in the catalogue. All 14 publishers:

  Mobilithek                     109
  Open.NRW                        54
  Open Data Baden-Württemberg     21
  Transparenzportal Hamburg       17
  Open Data Brandenburg           16
  Freistaat Sachsen               13
  GDI-DE                           9
  open.bydata                      6
  … 6 more: Land Rheinland-Pfalz 5, Land Sachsen-Anhalt 4, Open Data Hessen 3,
    Land Brandenburg 2, Berlin Open Data 2, Metropolregion Rhein-Neckar 1

Datasets carrying each format (plain and URI variants merged: 57 raw values → 41):

  CSV        82  █████████████
  HTML       79  ████████████
  WMS        49  ████████    (33 WMS_SRVC + 16 plain "WMS")
  GEOJSON    42  ███████
  JSON       41  ██████
  WFS        39  ██████      (26 WFS_SRVC + 13 plain "WFS")
  GML        28  ████
  BIN        27  ████
  XML        25  ████
  KML        22  ███
  SHP        19  ███         (another 13 "Shape", 5 "Shapefiles")
  … 26 more, down to single datasets (MQTT, ODS, PNG, TXT …)
  Not a format: 30 datasets are tagged "download"/"Download".

Licences: the package-level licence facet has a single entry. Only 2 of 262 datasets carry
"Datenlizenz Deutschland – Zero – Version 2.0" there. Read licences per resource instead.
```

Next steps offered: narrow the breakdown to one publisher (`--param fq=organization:mcloud`), or list the
datasets themselves with govdata-dataset-finder.

## govdata-dataset-finder

> Is there downloadable CSV data from bicycle counting stations (Fahrradzählstellen)? Freshest first.

```bash
govdata --compact search "Fahrradzählstellen" --rows 25 --sort "metadata_modified desc"
govdata --compact package daten-der-raddauerzahlstellen-munchen-2026     # full record for one hit
```

All 16 hits fit on one page. Every hit had an empty `license_id` and `isopen: false`, so licences were
read from `resources[].license`. The Munich series appeared four times across two portals (2024 through
open.bydata; 2025, 2026 and a yearly archive through Mobilithek) and was merged into one entry. Münster's
daily CSV is offered as a link that the harvester cut off mid-UUID, so it is flagged rather than called a
download. Münster's district counters offer only XLS/XLSX, so they rank below the CSV datasets.

```
"Fahrradzählstellen": 16 datasets in the catalogue. CSV first, then by last update:

1. Daten der Raddauerzählstellen München (2024–2026 + archive 2008–2025)   Landeshauptstadt München
   CSV · updated 2026-10-05 · DL-DE-BY 2.0 · 2026 edition: 14 files, 15-minute and daily values with weather, Jan–Jul
   → govdata package daten-der-raddauerzahlstellen-munchen-2026  (also …-2025, …-2024-1, …-jahreszahlen9524e)
2. Gebündelte Daten Eco-Counter Fahrradzählstellen Baden-Württemberg       MobiData BW
   CSV, JSON, XLSX, PDF · updated 2026-10-05 · DL-DE-BY 2.0 · 17 resources (2 have no URL; some URLs are
   templates with a {yyyymm} placeholder)
   → govdata package gebundelte-daten-eco-counter-fahrradzahlstellen-baden-wurttemberg9995b
3. Fahrradzählstellen in Heidelberg                         Stadt Heidelberg, Amt für Mobilität
   CSV, JSON (the JSON is an API call with an api-key in the URL) · updated 2026-10-05 · CC0 · 21 resources
   → govdata package fahrradzahlstellen-in-heidelberg
4. Verkehrszählung Fahrradverkehr: Tagesaktuelle Daten                      Stadt Münster
   CSV ("Git-Repository mit den tagesaktuellen CSV-Dateien"; the link is cut off, see the source portal)
   · updated 2026-10-05 · CC BY 3.0 DE
   → govdata package verkehrszahlung-fahrradverkehr-tagesaktuelle-datenffaff
5. Radfahrende an den Zählstellen in Stuttgart seit 2013                    Statistisches Amt Stuttgart
   CSV, XLSX · updated 2026-09-17 · CC BY 4.0 · 2 files
   → govdata package radfahrende-nach-zahlstellen
6. Fahrrad-Zählstellen Zeitreihe                                            Stadt Freiburg i. Br.
   CSV · updated 2026-07-17 · DL-DE-BY 2.0 · 1 file
   → govdata package fahrrad-zahlstellen-zeitreihe

No CSV: 5 Münster district datasets (XLS/XLSX, 8–32 files each, updated 2026-10-03/05; DL-DE-BY 2.0,
older years "other-closed"), plus the counter locations as GeoJSON.
Also matched: Verkehrszählung - Fahrradverkehr 2019 (Münster; HTML, XLSX, ZIP; "other-closed").
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

The full-text search also returned datasets that are not about drinking fountains (Ingolstadt
soil-moisture sensors and weather stations, Augsburg bike service points, the Krefeld cycling map as
PDF). The one such GeoJSON (Augsburg's service points) was dropped. Nine WMS/WFS/OAF service endpoints were left out. Only one file
states its size, so both downloads were capped at 2 MB.

```
Trinkwasserbrunnen · GeoJSON harvest: 27 datasets scanned (106 resources), 9 GeoJSON files in 8 datasets

trinkwasserbrunnen6a2dc (Stadt Dortmund) · DL-DE Zero 2.0 (given as a govdata.de URI)
  geojson                                     ?  https://open-data.dortmund.de/api/v2/catalog/datasets/trinkwasserbrunnen/exports/geojson
trinkbrunnen-stadt-moerse700d (Stadt Moers) · DL-DE Zero 2.0
  GeoJSON - Trinkbrunnen (Stadt Moers)        ?  https://geoportal-niederrhein.de/lgv-config/geojson/moers/Trinkbrunnen.geojson
kreis-herford-offentliche-trinkwasserbrunnen12af7 (Kreis Herford) · DL-DE-BY 2.0
  GeoJSON                                     ?  https://geoportal.kreis-herford.de/geoviewer/geodata/klimaschutz/trinkwasser_osm_4326.geojson
trinkwasserbrunnen-stadt-ingolstadt (Stadt Ingolstadt) · CC BY 4.0
  Standorte Trinkwasserbrunnen - GeoJSON      ?  https://www.ingolstadt.de/openbydata/GIS/Trinkwasserbrunnen_Ingolstadt.geojson
trinkwasserbrunnen-wuppertal02be6 (Stadt Wuppertal) · CC BY 4.0
  … WGS84 Länge/Breite, GeoJSON               ?  https://daten.wuppertal.de/Umwelt_Klima/Trinkwasserbrunnen_EPSG4326_JSON.json
  … ETRS89/UTM32, GeoJSON (not WGS84)         ?  https://daten.wuppertal.de/Umwelt_Klima/Trinkwasserbrunnen_EPSG25832_JSON.json
stadtplan-der-stadtischen-trinkbrunnen21a4d (Landeshauptstadt München) · DL-DE-BY 2.0
  WFS (GeoJSON), a live WFS query            ?  https://geoportal.muenchen.de/geoserver/baug_wfs/ows?service=WFS&…&outputFormat=application/json
trinkwasserbrunnen (Hanse- und Universitätsstadt Rostock) · CC0
  Trinkwasserspender                      826 B  https://geo.sv.rostock.de/download/opendata/trinkwasserspender/trinkwasserspender.json
trinkwasserbrunnen-in-augsburg (Stadt Augsburg) · CC BY 4.0
  Name und geograpische Verortung von Trinkwasserbrunnen in Augsburg  ?  https://www.augsburg.de/…/opendata/Trinkwasserbrunnen.geojson

Wrote trinkbrunnen-manifest.tsv: 9 rows (dataset, portal, publisher, file, size, licence, url)
Downloaded 2 files (both openly licensed):
  trinkwasserspender-rostock.json   826 B  FeatureCollection, 3 Point features
  trinkbrunnen-moers.geojson       1299 B  FeatureCollection, 3 Point features
```

Next steps offered: a `urls.txt` for `wget -i`, or the same harvest for CSV.
