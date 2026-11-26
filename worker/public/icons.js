// Original 24px SVG icons. Shared by interface controls and canvas map markers.
export const iconPaths = {
  turn_left: ["M12 20V13a3 3 0 0 0-3-3H4M8 6l-4 4 4 4"],
  turn_right: ["M12 20V13a3 3 0 0 1 3-3h5M16 6l4 4-4 4"],
  straight: ["M12 20V4M6.5 9.5 12 4l5.5 5.5"],
  cloud: ["M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.2 3.2 0 0 0 7 18Z"],
  rain: ["M7 14h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.2 3.2 0 0 0 7 14ZM8 18l-1 3M13 18l-1 3M18 18l-1 3"],
  ruler: ["M3 17 17 3l4 4L7 21Z", "m7 13 2 2M10 10l2 2M13 7l2 2"],
  share_view: ["M12 15V3M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"],
  fullscreen: ["M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"],
  coffee: ["M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM16 11h1.5a2.5 2.5 0 0 1 0 5H16M8 3v2M12 3v2"],
  bed: ["M3 18V6M3 14h18v4M21 14v-3a3 3 0 0 0-3-3h-7v6", "M8.5 10.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0"],
  fuel: ["M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M3 21h13M15 9h1.5a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V8l-2-2M7 8h5"],
  drive: ["M5 17v-6l2-5h10l2 5v6M3 17h18M7.5 14h.01M16.5 14h.01"],
  walk: ["M13 3a1.7 1.7 0 1 0 0 3.4A1.7 1.7 0 0 0 13 3Z", "m9 21 2-6-2-3 3-3 3 2 2 3M11 15l3 2v4"],
  mic: ["M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z", "M5 10v2a7 7 0 0 0 14 0v-2", "M12 19v3M8 22h8"],
  selected_place: [
    "M12 2a8 8 0 0 0-8 8c0 5.7 8 13 8 13s8-7.3 8-13a8 8 0 0 0-8-8Z",
    "M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  ],
  sun: [
    "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8",
    "M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5",
  ],
  moon: ["M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12Z"],
  monitor: ["M3 4h18v13H3V4ZM8 21h8M12 17v4"],
  map_default: ["m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5ZM9 3v16M15 5v16"],
  satellite: [
    "m5 3 4 4-4 4-4-4 4-4ZM19 13l4 4-4 4-4-4 4-4ZM9 7l8 8M9 11l4-4 4 4-4 4-4-4ZM3 16a5 5 0 0 1 5 5M3 12a9 9 0 0 1 9 9",
  ],
  terrain: ["m2 20 7-15 5 9 3-6 5 12H2ZM6 12l3 2 3-2"],
  bicycle: [
    "M9 16a4 4 0 1 1-8 0 4 4 0 0 1 8 0M23 16a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    "m5 16 5-9 5 9H5ZM10 7h7l2 9M8 4h4M16 4h3",
  ],
  traffic: [
    "M7 2h10v20H7V2ZM14 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0M14 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  ],
  buildings: [
    "m3 8 7-4 7 4v12l-7 3-7-3V8ZM3 8l7 4 7-4M10 12v11M17 9l4-2v12l-4 1M6 13v4M13 14v4",
  ],

  menu: ["M4 6h16M4 12h16M4 18h16"],
  search: ["M20 20l-5-5", "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0"],
  close: ["M6 6l12 12M18 6 6 18"],
  bookmark: ["M6 4h12v17l-6-4-6 4V4Z"],
  bookmark_check: ["M6 4h12v17l-6-4-6 4V4Z", "m9 10 2 2 4-4"],
  history: ["M4 8a9 9 0 1 1-1 8", "M4 3v5h5M12 7v5l3 2"],
  directions: ["m12 2 10 10-10 10L2 12 12 2Z", "M8 16v-5h8m-3-3 3 3-3 3"],
  layers: ["m12 3 10 5-10 5L2 8l10-5Z", "m3 12 9 5 9-5M3 16l9 5 9-5"],
  locate: [
    "M12 2v3M12 19v3M2 12h3M19 12h3",
    "M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
    "M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  ],
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  compass: [
    "m15.5 8.5-2 5-5 2 2-5 5-2Z",
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  ],
  share: [
    "M15 5a3 3 0 1 1 6 0 3 3 0 0 1-6 0M3 12a3 3 0 1 1 6 0 3 3 0 0 1-6 0M15 19a3 3 0 1 1 6 0 3 3 0 0 1-6 0",
    "m8.6 10.5 6.8-4M8.6 13.5l6.8 4",
  ],
  home: ["m3 11 9-8 9 8", "M5 10v11h5v-7h4v7h5V10"],
  place: [
    "M12 3a8 8 0 0 1 8 8c0 4-2.8 7.2-6.5 7.9l-.9 2.1q-.6.7-1.2 0l-.9-2.1A8 8 0 0 1 12 3Z",
    "M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  ],
  restaurant: [
    "M4 3v6a3 3 0 0 0 6 0V3M7 3v18",
    "M19 3c-4 3-5 7-5 10h5M19 3v18",
  ],
  shop: ["M4 8h16l1 13H3L4 8Z", "M8 8V6a4 4 0 0 1 8 0v2"],
  hospital: ["M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z"],
  bank: ["m2 8 10-5 10 5H2ZM4 21h16M6 11v6M12 11v6M18 11v6M3 18h18"],
  playground: ["m12 2 7 9h-4l5 6H4l5-6H5l7-9Z", "M12 17v5"],
  museum: ["m3 8 9-5 9 5H3ZM4 21h16M6 11v7M10 11v7M14 11v7M18 11v7"],
  place_of_worship: [
    "M5 21V10h14v11H5ZM7 10a5 5 0 0 1 10 0",
    "M12 5V2M10 21v-6h4v6M2 21h20",
  ],
  bus: [
    "M5 4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v15H5V4Z",
    "M5 12h14M8 16h.01M16 16h.01M7 19v3M17 19v3M9 5h6",
  ],
  town_hall: [
    "M4 21V7h16v14H4ZM9 7V3h6v4M9 21v-6h6v6",
    "M8 10h.01M12 10h.01M16 10h.01M2 21h20",
  ],
  monument: ["m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-6Z"],
  info: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", "M12 11v6M12 7h.01"],
};

export function icon(name, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `icon ${className}`.trim());
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of iconPaths[name] || iconPaths.place) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export function drawIcon(context, name, x, y, size, colour) {
  context.save();
  context.translate(x, y);
  context.scale(size / 24, size / 24);
  context.strokeStyle = colour;
  context.lineWidth = 1.9;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const d of iconPaths[name] || iconPaths.place)
    context.stroke(new Path2D(d));
  context.restore();
}

for (const node of document.querySelectorAll("[data-icon]")) {
  node.replaceChildren(icon(node.dataset.icon));
}
