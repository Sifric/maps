import { drawIcon } from "./icons.js";

const colours = {
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
  // Four physical pixels per CSS pixel keeps small map pins crisp.
  canvas.width = 144;
  canvas.height = 192;
  const c = canvas.getContext("2d");
  c.scale(4, 4);
  const aliases = { restaurant: "food", fast_food: "food", food_court: "food", hospital: "health", pharmacy: "health", hotel: "hotel", lodging: "hotel", park: "leisure", shop: "shopping" };
  const category = aliases[kind] || kind;
  const colour = colours[category] || colours[kind] || colours.other;
  c.fillStyle = "rgba(0,0,0,.25)";
  c.beginPath();
  c.ellipse(18, 45, 6, 2, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = colour;
  c.strokeStyle = "#fff";
  c.lineWidth = 2;
  c.lineJoin = "round";
  c.beginPath();
  c.moveTo(18, 1);
  c.bezierCurveTo(8.611, 1, 1, 8.611, 1, 18);
  c.bezierCurveTo(1, 30.75, 18, 45, 18, 45);
  c.bezierCurveTo(18, 45, 35, 30.75, 35, 18);
  c.bezierCurveTo(35, 8.611, 27.389, 1, 18, 1);
  c.closePath();
  c.fill();
  c.stroke();
  const filledIcons = {
    food: 'M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z',
    health: 'M19 3H5c-1.1 0-1.99.9-1.99 2L3 19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 11h-4v4h-4v-4H6v-4h4V6h4v4h4v4z',
    hotel: 'M7 13c1.66 0 3-1.34 3-3S8.66 7 7 7s-3 1.34-3 3 1.34 3 3 3zm12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9c0-2.21-1.79-4-4-4z',
    leisure: 'M17 12h2L12 2 5.05 12H7l-3.9 6h6.92v4h3.96v-4H21z',
    shopping: 'M18 6h-2c0-2.21-1.79-4-4-4S8 3.79 8 6H6c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6-2c1.1 0 2 .9 2 2h-4c0-1.1.9-2 2-2z',
  };
  c.fillStyle = "#fff";
  if (filledIcons[category]) {
    const path = new Path2D(filledIcons[category]);
    c.save(); c.translate(9, 9); c.scale(.75, .75); c.fill(path); c.restore();
  } else drawIcon(c, placeIcons[kind] || "place", 9, 9, 18, "#fff");
  return { width: 144, height: 192, data: c.getImageData(0, 0, 144, 192).data };
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
  delete pin.filter;
  pin.layout = {
    "icon-image": ["concat", "lk-pin-", ["get", "kind"]],
    "icon-size": [
      "interpolate",
      ["linear"],
      ["zoom"],
      7,
      0.72,
      12,
      0.66,
      14,
      0.60,
      16,
      0.55,
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
  marker.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="24" height="36" aria-hidden="true"><path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 24 12 24s12-15 12-24c0-6.627-5.373-12-12-12z" fill="#EA4335"/><circle cx="12" cy="12" r="4.5" fill="#FFFFFF"/></svg>';
  return marker;
}
