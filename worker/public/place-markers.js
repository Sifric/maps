import { icon, drawIcon } from "./icons.js";

const colours = {
  food: "#ff8126",
  shopping: "#0095f6",
  health: "#ef5261",
  finance: "#547bc4",
  leisure: "#18a879",
  culture: "#b44df0",
  worship: "#7b969f",
  transport: "#567a9a",
  government: "#78909c",
  landmark: "#b44df0",
  other: "#82969d",
};
export const placeIcons = {
  food: "restaurant",
  shopping: "shop",
  health: "hospital",
  finance: "bank",
  leisure: "playground",
  culture: "museum",
  worship: "place_of_worship",
  transport: "bus",
  government: "town_hall",
  landmark: "monument",
};
function dotImage(kind) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 144;
  const c = canvas.getContext("2d");
  c.scale(2, 2);
  c.fillStyle = colours[kind] || colours.other;
  c.beginPath();
  c.arc(32, 68, 5, 0, Math.PI * 2);
  c.fill();
  return { width: 128, height: 144, data: c.getImageData(0, 0, 128, 144).data };
}
function markerImage(kind) {
  const canvas = document.createElement("canvas");
  // 4× bitmap density keeps the circular outline smooth on high-DPI screens.
  canvas.width = 128;
  canvas.height = 144;
  const c = canvas.getContext("2d");
  c.scale(2, 2);
  const colour = colours[kind] || colours.other;
  c.shadowColor = "#0003";
  c.shadowBlur = 8;
  c.shadowOffsetY = 2;
  c.fillStyle = colour;
  c.strokeStyle = "#fff";
  c.lineWidth = 2.8;
  c.lineJoin = "round";
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(32, 7);
  c.bezierCurveTo(44.7, 7, 55, 17.3, 55, 30);
  c.bezierCurveTo(55, 41, 47.8, 50, 38, 52.4);
  c.bezierCurveTo(36, 52.8, 34.8, 57, 33, 58);
  c.quadraticCurveTo(32, 59, 31, 58);
  c.bezierCurveTo(29.2, 57, 28, 52.8, 26, 52.4);
  c.bezierCurveTo(16.2, 50, 9, 41, 9, 30);
  c.bezierCurveTo(9, 17.3, 19.3, 7, 32, 7);
  c.closePath();
  c.fill();
  c.stroke();
  c.shadowColor = "transparent";
  drawIcon(c, placeIcons[kind] || "place", 18, 15, 28, "#fff");
  return { width: 128, height: 144, data: c.getImageData(0, 0, 128, 144).data };
}
export function stylePlaces(style) {
  const layers = Object.fromEntries(style.layers.map((l) => [l.id, l]));
  const dot = layers["mazo-places-dot"];
  const pin = layers["mazo-places-icon"];
  if (!dot || !pin) return style;
  for (const id of [
    "mazo-places-pin",
    "mazo-places-label",
    "mazo-places-subtitle",
  ])
    if (layers[id])
      layers[id].layout = { ...(layers[id].layout || {}), visibility: "none" };
  // Fallback dots share the pin collision footprint, so they yield to named
  // pins and to each other instead of drawing an unrestricted cloud of points.
  dot.type = "symbol";
  delete dot.maxzoom;
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
    "icon-anchor": "bottom",
    "icon-allow-overlap": false,
    "icon-ignore-placement": false,
    "icon-padding": 8,
  };
  dot.paint = {};
  pin.minzoom = 7;
  delete pin.filter;
  pin.layout = {
    "icon-image": ["concat", "lk-pin-", ["get", "kind"]],
    "icon-size": [
      "interpolate",
      ["linear"],
      ["zoom"],
      7,
      0.65,
      12,
      0.8,
      14,
      0.85,
      16,
      0.9,
    ],
    "icon-anchor": "bottom",
    "icon-allow-overlap": false,
    "icon-padding": 8,
    "icon-optional": false,
    "text-field": /^en(?:-|$)/i.test(navigator.language)
      ? ["coalesce", ["get", "label"], ["get", "name"]]
      : ["get", "name"],
    "text-font": ["Mazo Maps Sans Regular"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 12, 12, 16, 13],
    "text-variable-anchor-offset": [
      "left",
      [1.1, -1.35],
      "right",
      [-1.1, -1.35],
      "bottom",
      [0, -2.3],
      "top",
      [0, 0.3],
    ],
    "text-justify": "auto",
    "text-optional": false,
    "text-allow-overlap": false,
    "text-padding": 6,
    "text-max-width": 10,
    "symbol-sort-key": [
      "match",
      ["get", "kind"],
      "food",
      1,
      "leisure",
      2,
      "culture",
      3,
      "shopping",
      4,
      "transport",
      5,
      "health",
      6,
      "finance",
      7,
      "worship",
      8,
      "government",
      9,
      10,
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
  const selectedLabel = structuredClone(pin);
  selectedLabel.id = "mazo-places-selected-label";
  selectedLabel.layout = Object.fromEntries(
    Object.entries(pin.layout).filter(
      ([key]) => key.startsWith("text-") || key === "symbol-sort-key",
    ),
  );
  selectedLabel.layout["text-allow-overlap"] = true;
  selectedLabel.layout["text-ignore-placement"] = true;
  selectedLabel.filter = ["==", ["id"], "__no_selected_place__"];
  selectedLabel.paint = { ...pin.paint };
  dot.layout["symbol-sort-key"] = pin.layout["symbol-sort-key"];
  // Geographic names keep placement priority over businesses at overview zooms.
  const base = style.layers.filter((layer) => layer !== dot && layer !== pin);
  const geographicNames = base.findIndex(
    (layer) => layer["source-layer"] === "place",
  );
  base.splice(geographicNames < 0 ? base.length : geographicNames, 0, dot, pin);
  base.push(selectedLabel);
  style.layers = base;
  return style;
}
export function registerPlaceImages(map) {
  map.on("styleimagemissing", ({ id }) => {
    if (map.hasImage(id)) return;
    if (id.startsWith("lk-pin-")) map.addImage(id, markerImage(id.slice(7)), { pixelRatio: 4 });
    if (id.startsWith("lk-dot-")) map.addImage(id, dotImage(id.slice(7)), { pixelRatio: 4 });
  });
}

export function selectedPlaceElement() {
  const marker = document.createElement("div");
  marker.className = "selected-marker";
  marker.append(icon("selected_place"));
  return marker;
}
