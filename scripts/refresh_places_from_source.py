#!/usr/bin/env python3
"""Rebuild Sifric place records from all configured Sifric/places branches.

Source-only identifiers are used for deduplication in a temporary SQLite
database and are never written to the resulting place JSON records.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tarfile
import time
import unicodedata
from urllib.request import urlopen

from import_places_archive import new_ulid
from numbered_shards import ShardAllocator

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data/places"
BRANCHES = (
    "feature/batticaloa-deduplication",
    "feature/northern-province-collector",
    "feature/southern-province-collector",
    "feature/local-selenium-collector",
    "main",
)
MIN_LAT, MAX_LAT, MIN_LON, MAX_LON = 5.9, 9.9, 79.5, 82.0
CELL_DEG = 0.002
MAX_DISTANCE_M = 150


def norm(value):
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", str(value)).casefold()))


def connect(path):
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.executescript("""
      CREATE TABLE places (
        seq INTEGER PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
        categories TEXT NOT NULL, address TEXT, hours TEXT, status TEXT,
        alternates TEXT NOT NULL, names TEXT NOT NULL, branches TEXT NOT NULL
      );
      CREATE TABLE ids (value TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TABLE names (value TEXT NOT NULL, gx INTEGER NOT NULL, gy INTEGER NOT NULL, seq INTEGER NOT NULL);
      CREATE INDEX names_lookup ON names(value,gx,gy);
    """)
    return db


def row_values(item):
    if not isinstance(item, dict):
        return None
    name = item.get("name")
    if not isinstance(name, str) or not name.strip():
        return None
    co = item.get("coordinates")
    if not isinstance(co, dict):
        co = {}
    try:
        lat, lon = float(co.get("latitude")), float(co.get("longitude"))
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(lat) and math.isfinite(lon) and MIN_LAT <= lat <= MAX_LAT and MIN_LON <= lon <= MAX_LON):
        return None
    cats = item.get("categories")
    if not isinstance(cats, list):
        cats = [item.get("main_category")]
    cats = list(dict.fromkeys(x.strip() for x in cats if isinstance(x, str) and x.strip()))
    if not cats:
        cats = ["Other"]
    address = item.get("address")
    if not isinstance(address, str) or not address.strip():
        address = None
    status = item.get("business_status") or item.get("status")
    if not isinstance(status, str) or not status.strip():
        if item.get("is_permanently_closed"):
            status = "permanently_closed"
        elif item.get("is_temporarily_closed"):
            status = "temporarily_closed"
        else:
            status = None
    keys = set()
    for field in ("place_id", "data_id", "kgmid"):
        value = item.get(field)
        if isinstance(value, str) and value.strip():
            keys.add(field + ":" + value.strip().casefold())
    # Also recognize source IDs embedded in Google Maps URLs.
    for field in ("link", "google_maps_url"):
        value = item.get(field)
        if isinstance(value, str):
            for token in re.findall(r"(?:!1s|!3d|place_id=)([^!&/]+)", value):
                if token and not re.fullmatch(r"-?\d+(?:\.\d+)?", token):
                    keys.add("url:" + token.casefold())
    return {
        "name": name.strip(), "lat": lat, "lon": lon, "categories": cats,
        "address": address, "hours": item.get("hours"), "status": status,
        "keys": keys,
    }


def distance_m(a_lat, a_lon, b_lat, b_lon):
    return math.hypot((a_lon-b_lon)*111320*math.cos(math.radians((a_lat+b_lat)/2)),
                      (a_lat-b_lat)*110540)


def ingest(db, item, branch):
    v = row_values(item)
    if not v:
        return False
    seq = None
    for key in sorted(v["keys"]):
        found = db.execute("SELECT seq FROM ids WHERE value=?", (key,)).fetchone()
        if found:
            seq = found[0]
            break
    normalized = norm(v["name"])
    if seq is None and normalized:
        gx, gy = math.floor(v["lon"]/CELL_DEG), math.floor(v["lat"]/CELL_DEG)
        candidates = db.execute(
            "SELECT p.seq,p.lat,p.lon FROM names n JOIN places p USING(seq) "
            "WHERE n.value=? AND n.gx BETWEEN ? AND ? AND n.gy BETWEEN ? AND ?",
            (normalized, gx-1, gx+1, gy-1, gy+1)).fetchall()
        close = [(distance_m(v["lat"],v["lon"],lat,lon), candidate)
                 for candidate,lat,lon in candidates]
        close = [pair for pair in close if pair[0] <= MAX_DISTANCE_M]
        if close:
            seq = min(close)[1]
    if seq is None:
        cats = json.dumps(v["categories"], ensure_ascii=False)
        alts = json.dumps([], ensure_ascii=False)
        names = json.dumps([], ensure_ascii=False)
        branches = json.dumps([branch])
        cur = db.execute("INSERT INTO places(name,lat,lon,categories,address,hours,status,alternates,names,branches) VALUES(?,?,?,?,?,?,?,?,?,?)",
                         (v["name"],v["lat"],v["lon"],cats,v["address"],json.dumps(v["hours"],ensure_ascii=False) if v["hours"] not in (None,"",[]) else None,v["status"],alts,names,branches))
        seq = cur.lastrowid
        if normalized:
            db.execute("INSERT INTO names VALUES(?,?,?,?)", (normalized,math.floor(v["lon"]/CELL_DEG),math.floor(v["lat"]/CELL_DEG),seq))
    else:
        old = db.execute("SELECT name,categories,address,hours,status,alternates,names,branches FROM places WHERE seq=?",(seq,)).fetchone()
        name,categories,address,hours,status,alternates,names,branches = old
        cats=json.loads(categories); known={norm(x) for x in cats}
        for cat in v["categories"]:
            if norm(cat) not in known: cats.append(cat); known.add(norm(cat))
        alts=json.loads(alternates); aliases=json.loads(names); src_branches=json.loads(branches)
        if v["name"] != name and v["name"] not in aliases: aliases.append(v["name"])
        if v["address"] and v["address"] != address and v["address"] not in alts:
            if address: alts.append(address)
            address=v["address"]
        if not hours and v["hours"] not in (None,"",[]): hours=json.dumps(v["hours"],ensure_ascii=False)
        if not status and v["status"]: status=v["status"]
        if branch not in src_branches: src_branches.append(branch)
        db.execute("UPDATE places SET categories=?,address=?,hours=?,status=?,alternates=?,names=?,branches=? WHERE seq=?",
                   (json.dumps(cats,ensure_ascii=False),address,hours,status,json.dumps(alts,ensure_ascii=False),json.dumps(aliases,ensure_ascii=False),json.dumps(src_branches),seq))
    for key in sorted(v["keys"]):
        db.execute("INSERT OR IGNORE INTO ids(value,seq) VALUES(?,?)",(key,seq))
    return True


def iter_results(branch):
    import urllib.parse
    url = "https://codeload.github.com/Sifric/places/tar.gz/refs/heads/" + urllib.parse.quote(branch, safe="/")
    print(f"Reading source branch: {branch}", flush=True)
    with urlopen(url, timeout=120) as response:
        with tarfile.open(fileobj=response, mode="r|gz") as archive:
            for member in archive:
                if not member.isfile() or not member.name.lower().endswith(".json"):
                    continue
                stream=archive.extractfile(member)
                if stream is None: continue
                try: payload=json.load(stream)
                except (UnicodeDecodeError,json.JSONDecodeError): continue
                rows=payload.get("results") if isinstance(payload,dict) else None
                if isinstance(rows,list):
                    for row in rows: yield row


def main():
    tmp=ROOT/"build/place-dedupe.sqlite"
    tmp.parent.mkdir(parents=True,exist_ok=True)
    if tmp.exists(): tmp.unlink()
    db=connect(tmp)
    seen=valid=0
    for branch in BRANCHES:
        for row in iter_results(branch):
            seen+=1
            valid+=ingest(db,row,branch)
            if seen % 50000 == 0:
                db.commit(); print(f"Processed {seen:,} source rows; retained {db.execute('select count(*) from places').fetchone()[0]:,}",flush=True)
        db.commit()
    total=db.execute("SELECT count(*) FROM places").fetchone()[0]
    if total < 1000:
        raise SystemExit(f"Refusing to replace place data with only {total} records")
    print(f"Deduplicated {seen:,} rows to {total:,} Sri Lanka place records",flush=True)
    staging=ROOT/"build/places-new"
    if staging.exists(): shutil.rmtree(staging)
    staging.mkdir(parents=True)
    allocator=ShardAllocator({})
    cur=db.execute("SELECT name,lat,lon,categories,address,hours,status,alternates,names,branches FROM places ORDER BY seq")
    for name,lat,lon,cats,address,hours,status,alts,names,branches in cur:
        rid=new_ulid()
        record={"id":rid,"name":name,"coordinates":{"latitude":lat,"longitude":lon},
                "categories":json.loads(cats),"source":{"provider":"Sifric/places","branches":json.loads(branches)}}
        if address: record["address"]=address
        if hours:
            try: record["hours"]=json.loads(hours)
            except json.JSONDecodeError: pass
        if status: record["business_status"]=status
        alternate_addresses=json.loads(alts)
        if alternate_addresses: record["alternate_addresses"]=alternate_addresses
        source_names=json.loads(names)
        if source_names: record["source"]["names"]=source_names
        shard_path=allocator.allocate(rid+".json")
        folder=staging/shard_path.parent
        folder.mkdir(parents=True,exist_ok=True)
        (staging/shard_path).write_text(json.dumps(record,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    db.close()
    if DATA.exists(): shutil.rmtree(DATA)
    staging.rename(DATA)
    print(f"Wrote {total:,} records in numbered shards (maximum 999 each)",flush=True)
    try: tmp.unlink()
    except FileNotFoundError: pass


if __name__ == "__main__":
    main()
