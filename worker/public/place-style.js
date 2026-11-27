export const colours = {
  food: "#FF9800",
  shopping: "#1E88E5",
  health: "#E53935",
  hotel: "#8E24AA",
  finance: "#547bc4",
  leisure: "#43A047",
  culture: "#8E24AA",
  worship: "#7b969f",
  transport: "#567a9a",
  government: "#78909c",
  landmark: "#b44df0",
  other: "#82969d",
};

export function stylePlaces(style, language = globalThis.navigator?.language || "en") {
  const layers = Object.fromEntries(style.layers.map((l) => [l.id, l]));
  const dot = layers["mazo-places-dot"];
  const pin = layers["mazo-places-icon"];
  if (!dot || !pin) return style;
  // Use the same bold face for named places at every rendered zoom level.
  for (const layer of style.layers) {
    if (layer["source-layer"] === "place" || layer["source-layer"] === "poi") {
      if (layer.layout?.["text-field"]) {
        layer.layout["text-font"] = ["Geist Bold"];
      }
    }
  }
  for (const id of [
    "label_other",
    "mazo-places-pin",
    "mazo-places-label",
    "mazo-places-subtitle",
  ])
    if (layers[id])
      layers[id].layout = { ...(layers[id].layout || {}), visibility: "none" };
  // Fallback dots share the pin collision footprint, so they yield to named
  // pins and to each other instead of drawing an unrestricted cloud of points.
  dot.type = "symbol";
  dot.layout = {
    "icon-image": ["concat", "lk-dot-", ["get", "kind"]],
    "icon-size": [
      "interpolate",
      ["linear"],
      ["zoom"],
      7,
      0.65,
      12,
      0.8,
      16,
      0.9,
    ],
    "icon-anchor": "center",
    "icon-allow-overlap": false,
    "icon-ignore-placement": false,
    "icon-padding": 4,
  };
  dot.paint = {};
  delete pin.filter;
  pin.layout = {
    "icon-image": ["concat", "lk-pin-", ["get", "kind"]],
    "icon-size": [
      "interpolate",
      ["linear"],
      ["zoom"],
      7,
      0.65,
      10,
      0.70,
      12,
      0.76,
      14,
      0.82,
      16,
      0.87,
      18,
      0.92,
    ],
    "icon-anchor": "center",
    "icon-allow-overlap": false,
    "icon-padding": 14,
    "icon-optional": false,
    "text-field": /^en(?:-|$)/i.test(language)
      ? ["coalesce", ["get", "label"], ["get", "name"]]
      : ["get", "name"],
    "text-font": ["Geist Bold"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 12, 9, 16, 10, 18, 10.5],
    "text-anchor": "left",
    "text-offset": [1.35, 0],
    "text-justify": "auto",
    "text-optional": false,
    "text-allow-overlap": false,
    "text-padding": 12,
    "text-max-width": 8,
    "symbol-sort-key": [
      "match",
      ["get", "kind"],
      "health",
      1,
      "leisure",
      2,
      "transport",
      3,
      "food",
      4,
      "shopping",
      5,
      "culture",
      6,
      "worship",
      7,
      "landmark",
      8,
      "finance",
      9,
      "government",
      10,
      11,
    ],
  };
  pin.paint = {
    "text-color": [
      "match",
      ["get", "kind"],
      ...Object.entries(colours)
        .filter(([k]) => k !== "other")
        .flat(),
      colours.other,
    ],
    "text-halo-color": "#ffffff",
    "text-halo-width": 1.5,
    "text-halo-blur": 0.5,
  };
  dot.layout["symbol-sort-key"] = pin.layout["symbol-sort-key"];
  // Geographic names keep placement priority over businesses at overview zooms.
  const base = style.layers.filter((layer) => layer !== dot && layer !== pin);
  const geographicNames = base.findIndex(
    (layer) => layer["source-layer"] === "place",
  );
  base.splice(geographicNames < 0 ? base.length : geographicNames, 0, dot, pin);
  style.layers = base;
  return style;
}
