#!/usr/bin/env python3
"""Compile selected Sri Lanka GTFS service days to a chronological connection index."""
import csv
from datetime import date, timedelta
import io
import json
from pathlib import Path
import sys
import zipfile
from zoneinfo import ZoneInfo
from datetime import datetime

DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def seconds(text):
    h, m, s = map(int, text.split(":"))
    if not (0 <= h < 48 and 0 <= m < 60 and 0 <= s < 60):
        raise ValueError("Invalid GTFS time")
    return h * 3600 + m * 60 + s


def build(source, target, today):
    with zipfile.ZipFile(source) as archive:
        def rows(key, optional=False):
            name = key + ".txt"
            if optional and name not in archive.namelist():
                return []
            member = archive.getinfo(name)
            if member.file_size > 20 * 1024**2:
                raise ValueError("GTFS file exceeds import limit")
            return list(csv.DictReader(io.StringIO(archive.read(member).decode("utf-8-sig"))))
        agency = rows("agency")
        if not agency or any(item["agency_timezone"] != "Asia/Colombo" for item in agency):
            raise ValueError("Expected Sri Lanka GTFS")
        stops, index = [], {}
        for stop in rows("stops"):
            lat, lon = float(stop["stop_lat"]), float(stop["stop_lon"])
            if 5 <= lat <= 10.5 and 78 <= lon <= 82.5:
                index[stop["stop_id"]] = len(stops)
                stops.append([stop["stop_name"], lon, lat])
        routes = {row["route_id"]: [row["route_short_name"], row["route_long_name"], row["route_type"]]
                  for row in rows("routes")}
        calendars = rows("calendar", True)
        exceptions = rows("calendar_dates", True)
        dates = {}
        for day in (today + timedelta(days=i) for i in range(-1, 4)):
            key = day.strftime("%Y%m%d")
            active = {cal["service_id"] for cal in calendars
                      if cal["start_date"] <= key <= cal["end_date"] and cal[DAYS[day.weekday()]] == "1"}
            for row in exceptions:
                if row["date"] == key:
                    if row["exception_type"] == "1":
                        active.add(row["service_id"])
                    elif row["exception_type"] == "2":
                        active.discard(row["service_id"])
            if active:
                dates[day.isoformat()] = active
        trips = {row["trip_id"]: (row["service_id"], row["route_id"]) for row in rows("trips")}
        from collections import defaultdict
        times = defaultdict(list)
        active = set().union(*dates.values())
        for row in rows("stop_times"):
            trip = trips.get(row["trip_id"])
            if trip and trip[0] in active:
                times[row["trip_id"]].append(row)
        days = {key: [] for key in dates}
        for trip_id, time_rows in times.items():
            service, route_id = trips[trip_id]
            if route_id not in routes:
                continue
            time_rows.sort(key=lambda row: int(row["stop_sequence"]))
            for a, b in zip(time_rows, time_rows[1:]):
                if a["stop_id"] not in index or b["stop_id"] not in index or not a["departure_time"] or not b["arrival_time"]:
                    continue
                depart, arrive = seconds(a["departure_time"]), seconds(b["arrival_time"])
                if arrive < depart:
                    continue
                edge = [depart, arrive, index[a["stop_id"]], index[b["stop_id"]], trip_id, route_id,
                        a.get("pickup_type", "0") in ("", "0"), b.get("drop_off_type", "0") in ("", "0")]
                for key, services in dates.items():
                    if service in services:
                        days[key].append(edge)
        for edges in days.values():
            edges.sort(key=lambda edge: edge[0])
        payload = {"agency": agency[0]["agency_name"], "source": agency[0]["agency_url"], "stops": stops,
                   "routes": routes, "days": {key: edges for key, edges in days.items() if edges}}
        if not payload["days"]:
            raise ValueError("GTFS has no scheduled trips in the supported date window")
        serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        if len(serialized.encode()) > 2_000_000:
            raise ValueError("GTFS index exceeds Worker input limit")
        Path(target).write_text(serialized, encoding="utf-8")
        print(f"Compiled {len(routes)} routes for {', '.join(payload['days'])}")


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2], date.fromisoformat(sys.argv[3]) if len(sys.argv) > 3 else
          datetime.now(ZoneInfo("Asia/Colombo")).date())
