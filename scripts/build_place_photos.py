#!/usr/bin/env python3
"""Match linked Wikimedia images to places, preserving source attribution."""
import argparse
from collections import defaultdict
import gzip
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import re
import subprocess
import time
import unicodedata
from urllib.parse import unquote, urlencode, urlsplit, urlunsplit

import osmium


def normalized(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def canonical_file(value):
    name = value.replace("_", " ").strip()
    return name if re.fullmatch(r"File:[^<>:#|{}\[\]\x00-\x1f]{1,220}\.(jpg|jpeg|png|webp)", name, re.I) else None


def media_reference(tags):
    file = canonical_file(tags.get("wikimedia_commons", ""))
    if file:
        return file
    try:
        link = urlsplit(tags.get("image", ""))
        if link.hostname == "commons.wikimedia.org" and link.path.startswith("/wiki/File:"):
            file = canonical_file(unquote(link.path.removeprefix("/wiki/")))
            if file:
                return file
    except ValueError:
        pass
    entity = tags.get("wikidata", "")
    return entity if re.fullmatch(r"Q[1-9][0-9]{0,12}", entity) else None


class LinkedPlaces(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.records = []

    def record(self, tags, reference, lon, lat):
        names = {normalized(tags.get(key, "")) for key in ("name", "name:en", "name:ta", "name:si", "official_name", "alt_name")}
        names.discard("")
        if names:
            self.records.append((names, reference, lon, lat))

    def node(self, node):
        if node.location.valid() and (reference := media_reference(node.tags)):
            self.record(node.tags, reference, node.location.lon, node.location.lat)

    def way(self, way):
        reference = media_reference(way.tags)
        if not reference:
            return
        points = [(node.lon, node.lat) for node in way.nodes if node.location.valid()]
        if not points:
            return
        bounds = [(min(point[i] for point in points), max(point[i] for point in points)) for i in range(2)]
        if all(high - low <= 0.03 for low, high in bounds):
            self.record(way.tags, reference, *((low + high) / 2 for low, high in bounds))


def match_places(records, search_index):
    names = {name for aliases, *_ in records for name in aliases}
    by_name = defaultdict(list)
    with gzip.open(search_index, "rt", encoding="utf-8") as source:
        for row in json.load(source):
            for name in {normalized(row[1]), normalized(row[6]) if len(row) > 6 else ""} & names:
                by_name[name].append(row)
    matches = defaultdict(set)
    for aliases, reference, lon, lat in records:
        longitude_scale = math.cos(math.radians(lat))
        nearby = {
            row[0] for alias in aliases for row in by_name[alias]
            if math.hypot((row[2] - lon) * longitude_scale, row[3] - lat) * 111195 < 125
        }
        if len(nearby) == 1:
            matches[nearby.pop()].add(reference)
    return matches


def api(origin, parameters):
    lag = 60 if origin == "https://www.wikidata.org" else 5
    url = origin + "/w/api.php?" + urlencode(parameters | {"format": "json", "maxlag": lag})
    for attempt in range(4):
        try:
            data = subprocess.check_output([
                "curl", "--fail", "--silent", "--show-error", "--max-time", "25", "--max-filesize", str(10 * 1024 ** 2),
                "--user-agent", "SifricMaps/1.0 (https://maps.sifric.workers.dev/)", url,
            ])
            result = json.loads(data)
            if "error" not in result:
                return result
            raise ValueError(result["error"].get("code", "Wikimedia error"))
        except (subprocess.CalledProcessError, ValueError):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def groups(values, size):
    ordered = sorted(set(values))
    for i in range(0, len(ordered), size):
        yield ordered[i:i + size]


def entity_files(entities):
    found = {}
    for batch in groups(entities, 30):
        result = api("https://www.wikidata.org", {"action": "wbgetentities", "ids": "|".join(batch), "props": "claims"})
        for entity, record in result["entities"].items():
            claims = record.get("claims", {}).get("P18", ())
            for photo in sorted(claims, key=lambda item: item.get("rank") != "preferred"):
                value = photo.get("mainsnak", {}).get("datavalue", {}).get("value")
                if isinstance(value, str) and photo.get("rank") != "deprecated":
                    if file := canonical_file("File:" + value):
                        found[entity] = file
                        break
        time.sleep(1)
    return found


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.fragments = []

    def handle_data(self, data):
        self.fragments.append(data)


def plain(value):
    parser = PlainText()
    parser.feed(value)
    return " ".join(" ".join(parser.fragments).split())[:240]


def clean_url(value, hosts, remove_query=False):
    url = urlsplit(value)
    if url.scheme != "https" or url.hostname not in hosts or url.username or url.password:
        return None
    return urlunsplit((url.scheme, url.netloc, url.path, "" if remove_query else url.query, ""))


def image_record(title, info):
    meta = info.get("extmetadata", {})
    def attr(name):
        return meta.get(name, {}).get("value", "")
    license_name = plain(attr("LicenseShortName"))
    is_public_domain = license_name.casefold() in {"public domain", "cc0", "cc0 1.0"}
    is_cc = bool(re.fullmatch(r"CC BY(?:-SA)? (?:[1-4]\.0|2\.5)", license_name))
    if not (is_cc or is_public_domain) or info.get("mime") not in {"image/jpeg", "image/png", "image/webp"}:
        return None
    license_url = clean_url(attr("LicenseUrl"), {"creativecommons.org", "www.creativecommons.org"})
    author = plain(attr("Artist"))
    if is_cc and (not author or not license_url):
        return None
    thumb = clean_url(info.get("thumburl", ""), {"upload.wikimedia.org", "thumb.wikimedia.org"}, remove_query=True)
    source = clean_url(info.get("descriptionurl", ""), {"commons.wikimedia.org"})
    if not (thumb and source):
        return None
    return {
        "title": title.removeprefix("File:"),
        "thumbnailUrl": thumb,
        "sourcePage": source,
        "author": author or None,
        "license": license_name,
        "licenseUrl": license_url,
    }


def commons_metadata(files):
    photos = {}
    for batch in groups(files, 25):
        payload = api("https://commons.wikimedia.org", {
            "action": "query", "formatversion": 2, "titles": "|".join(batch), "redirects": 1, "prop": "imageinfo",
            "iiprop": "url|mime|extmetadata", "iiurlwidth": 640, "iilimit": 1,
            "iiextmetadatafilter": "Artist|LicenseShortName|LicenseUrl",
        })["query"]
        aliases = {entry["from"]: entry["to"] for entry in payload.get("normalized", []) + payload.get("redirects", [])}
        for page in payload["pages"]:
            if page.get("imageinfo") and (record := image_record(page["title"], page["imageinfo"][0])):
                photos[page["title"]] = record
        for title in batch:
            resolved = aliases.get(title, title)
            resolved = aliases.get(resolved, resolved)
            if resolved in photos:
                photos[title] = photos[resolved]
        time.sleep(0.25)
    return photos


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("osm", type=Path)
    parser.add_argument("search_index", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    handler = LinkedPlaces()
    handler.apply_file(str(args.osm), locations=True)
    matches = match_places(handler.records, args.search_index)
    entities = entity_files(ref for refs in matches.values() for ref in refs if ref.startswith("Q"))
    accepted = {
        place: sorted({entities.get(ref, ref) for ref in refs if ref in entities or ref.startswith("File:")})
        for place, refs in matches.items()
    }
    photos = commons_metadata(file for files in accepted.values() for file in files)
    catalog = {place: [photos[file] for file in files if file in photos][:5] for place, files in accepted.items()}
    catalog = {place: records for place, records in catalog.items() if records}
    if not catalog:
        raise ValueError("No licensed photos matched the place index")
    args.output.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    print(f"Imported photos for {len(catalog)} places")


if __name__ == "__main__":
    main()
