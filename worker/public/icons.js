// Original 24px SVG icons. Shared by interface controls and canvas map markers.
export const iconPaths = {
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
    "M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z",
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
