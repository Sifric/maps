const DEFAULTS = {
  theme: "system",
  type: "default",
  places: true,
  placesPreferenceVersion: 2,
  labels: true,
  details: {
    transit: false,
    bicycling: false,
    buildings: false,
    traffic: false,
  },
};
const STORAGE = "lk-map-settings";
const $ = (id) => document.getElementById(id);
const COPY = {
  transit: "Mapped stops & rail · no live arrivals",
  bicycling: "Mapped cycleways & bicycle access",
  buildings: "OSM building heights · 3D",
  traffic: "Live feed not connected",
};

function restore() {
  const result = structuredClone(DEFAULTS);
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE) || "{}");
    if (["light", "dark", "system"].includes(value.theme))
      result.theme = value.theme;
    if (["default", "satellite", "terrain"].includes(value.type))
      result.type = value.type;
    for (const key of ["places", "labels"])
      if (typeof value[key] === "boolean" &&
          (key !== "places" || value.placesPreferenceVersion === 2))
        result[key] = value[key];
    for (const key of ["transit", "bicycling", "buildings"])
      if (typeof value.details?.[key] === "boolean")
        result.details[key] = value.details[key];
  } catch {
    /* Keep defaults when storage is unavailable or malformed. */
  }
  return result;
}

export function detailAvailability(name, type, zoom) {
  if (name === "traffic") return { available: false, reason: COPY.traffic };
  const minimum = { transit: 10, bicycling: 12, buildings: 15 }[name];
  if (name === "buildings" && type === "satellite")
    return {
      available: false,
      reason: "Use Default or Terrain for 3D buildings",
    };
  if (zoom < minimum)
    return { available: false, reason: `Zoom in to ${minimum}+` };
  return { available: true, reason: COPY[name] };
}

function darkColour(layer, property) {
  const source = layer["source-layer"],
    id = layer.id;
  if (property.includes("halo")) return "#242b33";
  if (
    property === "background-color" ||
    source === "water" ||
    source === "waterway"
  )
    return "#172e3e";
  if (source === "water_name") return "#83b9d1";
  if (property.startsWith("text"))
    return source === "transportation_name" ? "#bdc7d3" : "#e2e7ed";
  if (source === "building")
    return property.includes("outline") ? "#56616e" : "#3e4855";
  if (source === "transportation") {
    if (layer.type === "line")
      return id.includes("casing")
        ? "#1a2029"
        : /motorway|primary|trunk|secondary|tertiary/.test(id)
          ? "#626f81"
          : "#424d5b";
    return "#424d5b";
  }
  if (source === "park" || /wood|grass|cemetery/.test(id)) return "#243e34";
  if (source === "boundary") return "#788495";
  if (/hospital/.test(id)) return "#422f3a";
  if (/school|pitch|track/.test(id)) return "#303d39";
  if (/sand/.test(id)) return "#494333";
  if (layer.type === "line") return "#596674";
  return "#252e38";
}

function scaleWidth(value, factor) {
  if (typeof value === "number") return value * factor;
  if (!Array.isArray(value)) return value;
  const result = structuredClone(value);
  if (result[0] === "interpolate") {
    for (let i = 4; i < result.length; i += 2)
      result[i] =
        typeof result[i] === "number"
          ? result[i] * factor
          : ["*", factor, result[i]];
    return result;
  }
  if (result[0] === "step") {
    result[2] =
      typeof result[2] === "number"
        ? result[2] * factor
        : ["*", factor, result[2]];
    for (let i = 4; i < result.length; i += 2)
      result[i] =
        typeof result[i] === "number"
          ? result[i] * factor
          : ["*", factor, result[i]];
    return result;
  }
  return JSON.stringify(value).includes('"zoom"')
    ? value
    : ["*", factor, value];
}

export function initialMapStyle(style) {
  const settings = restore();
  const isDark =
    settings.theme === "dark" ||
    (settings.theme === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  if (!isDark) return style;
  const result = structuredClone(style);
  for (const layer of result.layers)
    for (const key of Object.keys(layer.paint || {})) {
      if (!key.endsWith("color")) continue;
      if (layer.id.startsWith("mazo-places")) {
        if (key === "text-halo-color") layer.paint[key] = "#202124";
      } else layer.paint[key] = darkColour(layer, key);
    }
  return result;
}

export function createMapOptions(map, { baseStyle, status }) {
  const settings = restore(),
    media = matchMedia("(prefers-color-scheme: dark)");
  const baseLayers = structuredClone(baseStyle.layers),
    failures = new Set();
  let lastAppearance = "",
    raised = false;
  const dark = () =>
    settings.theme === "dark" || (settings.theme === "system" && media.matches);
  function persist() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(settings));
    } catch {
      /* Preferences need not block the map. */
    }
  }
  function visibility(id, visible) {
    const value = visible ? "visible" : "none";
    if (map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== value)
      map.setLayoutProperty(id, "visibility", value);
  }
  function addOverlays() {
    const before = baseLayers.find((l) => l.type === "symbol")?.id;
    map.addLayer(
      {
        id: "lk-detail-transit",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 10,
        filter: ["in", ["get", "class"], ["literal", ["rail", "transit"]]],
        layout: { visibility: "none", "line-cap": "round" },
        paint: {
          "line-color": "#3385ed",
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 16, 5],
          "line-opacity": 0.9,
        },
      },
      before,
    );
    map.addLayer(
      {
        id: "lk-detail-cycling",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 12,
        filter: [
          "all",
          ["!=", ["get", "bicycle"], "no"],
          ["!", ["in", ["get", "access"], ["literal", ["no", "private"]]]],
          [
            "any",
            ["==", ["get", "subclass"], "cycleway"],
            [
              "in",
              ["get", "bicycle"],
              ["literal", ["yes", "designated", "official"]],
            ],
          ],
        ],
        layout: { visibility: "none", "line-cap": "round" },
        paint: {
          "line-color": "#16a66a",
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 16, 5],
          "line-dasharray": [2, 1],
          "line-opacity": 0.95,
        },
      },
      before,
    );
    map.addLayer(
      {
        id: "lk-detail-buildings",
        type: "fill-extrusion",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 15,
        filter: [
          "all",
          ["!=", ["get", "hide_3d"], true],
          [">", ["coalesce", ["get", "render_height"], 0], 0],
        ],
        layout: { visibility: "none" },
        paint: {
          "fill-extrusion-color": "#d4dce4",
          "fill-extrusion-height": [
            "max",
            0,
            ["coalesce", ["get", "render_height"], 0],
          ],
          "fill-extrusion-base": [
            "max",
            0,
            ["coalesce", ["get", "render_min_height"], 0],
          ],
          "fill-extrusion-opacity": 0.92,
        },
      },
      before,
    );
  }
  function ensureProvider() {
    if (settings.type === "satellite" && !map.getSource("lk-satellite")) {
      map.addSource("lk-satellite", {
        type: "raster",
        tiles: [
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          "Imagery © Esri, Vantor, Earthstar Geographics, and the GIS User Community",
      });
      map.addLayer(
        {
          id: "lk-satellite",
          type: "raster",
          source: "lk-satellite",
          layout: { visibility: "none" },
          paint: { "raster-fade-duration": 200 },
        },
        baseLayers.find((l) => l.type !== "background")?.id,
      );
    }
    if (settings.type === "terrain" && !map.getSource("lk-elevation")) {
      map.addSource("lk-elevation", {
        type: "raster-dem",
        tiles: [
          "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        encoding: "terrarium",
        maxzoom: 14,
        attribution:
          'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Mapzen / AWS Open Data</a>',
      });
      map.addLayer(
        {
          id: "lk-hillshade",
          type: "hillshade",
          source: "lk-elevation",
          layout: { visibility: "none" },
          paint: {
            "hillshade-exaggeration": 0.55,
            "hillshade-shadow-color": "#66734b",
            "hillshade-highlight-color": "#ffffff",
            "hillshade-accent-color": "#8d9c70",
          },
        },
        baseLayers.find((l) => l.type === "line")?.id,
      );
    }
  }
  function applyAppearance() {
    const current = `${settings.type}/${dark()}/${settings.labels}`;
    if (current === lastAppearance) return;
    lastAppearance = current;
    document.documentElement.dataset.theme = dark() ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]').content = dark()
      ? "#202124"
      : "#ffffff";
    ensureProvider();
    for (const layer of baseLayers) {
      let show = layer.layout?.visibility !== "none";
      if (settings.type === "satellite") {
        if (["fill", "fill-extrusion", "background"].includes(layer.type))
          show = false;
        if (!settings.labels && !layer.id.startsWith("mazo-places"))
          show = false;
      }
      if (
        settings.type === "satellite" &&
        layer.type === "line" &&
        (layer["source-layer"] !== "transportation" ||
          layer.id.includes("casing"))
      )
        show = false;
      if (layer.id === "building-3d") show = false;
      if (layer.type === "line") {
        const width = layer.paint?.["line-width"];
        map.setPaintProperty(
          layer.id,
          "line-width",
          settings.type === "satellite" && width !== undefined
            ? scaleWidth(width, 0.45)
            : width,
        );
        map.setPaintProperty(
          layer.id,
          "line-opacity",
          settings.type === "satellite" ? 0.55 : layer.paint?.["line-opacity"],
        );
      }
      visibility(layer.id, show);
      for (const [key, value] of Object.entries(layer.paint || {})) {
        if (!key.endsWith("color")) continue;
        let colour = dark() ? darkColour(layer, key) : value;
        if (layer.id.startsWith("mazo-places")) {
          if (key === "text-halo-color")
            colour =
              dark() || settings.type === "satellite" ? "#202124" : value;
          else colour = value;
        } else if (settings.type === "satellite" && layer.type === "symbol")
          colour = key.includes("halo") ? "#202124" : "#ffffff";
        else if (settings.type === "satellite" && layer.type === "line")
          colour = key.includes("color") ? "#e7edf2" : colour;
        map.setPaintProperty(layer.id, key, colour);
      }
    }
    visibility("lk-satellite", settings.type === "satellite");
    visibility("lk-hillshade", settings.type === "terrain");
    if (map.getLayer("lk-hillshade")) {
      map.setPaintProperty(
        "lk-hillshade",
        "hillshade-shadow-color",
        dark() ? "#080e15" : "#66734b",
      );
      map.setPaintProperty(
        "lk-hillshade",
        "hillshade-highlight-color",
        dark() ? "#72816c" : "#ffffff",
      );
    }
    map.setPaintProperty(
      "lk-detail-buildings",
      "fill-extrusion-color",
      dark() ? "#586475" : "#d4dce4",
    );
  }
  function updateUI() {
    for (const b of document.querySelectorAll("[data-theme-choice]"))
      b.setAttribute(
        "aria-checked",
        String(b.dataset.themeChoice === settings.theme),
      );
    for (const b of document.querySelectorAll("[data-map-type]")) {
      b.setAttribute(
        "aria-checked",
        String(b.dataset.mapType === settings.type),
      );
      b.disabled = failures.has(b.dataset.mapType);
      b.title = b.disabled ? "Provider unavailable in this session" : "";
    }
    $("map-type-note").textContent = {
      default: "OSM streets and places",
      satellite: "Satellite / aerial imagery · detail varies by location",
      terrain: "Elevation hillshade · terrain resolution varies by location",
    }[settings.type];
    $("map-provider-note").textContent = {
      default: "© OpenStreetMap contributors",
      satellite:
        "Imagery: Esri, Vantor, Earthstar Geographics and the GIS User Community. Labels: OpenStreetMap.",
      terrain: "OpenStreetMap with Mapzen terrain tiles from AWS Open Data.",
    }[settings.type];
    $("show-places").checked = settings.places;
    $("satellite-labels").checked = settings.labels;
    $("satellite-label-option").hidden = settings.type !== "satellite";
    $("layers").dataset.activeMapType = settings.type;
    $("layers").setAttribute(
      "aria-label",
      `Layers: ${settings.type}, ${settings.theme} theme`,
    );
    for (const button of document.querySelectorAll("[data-map-detail]")) {
      const name = button.dataset.mapDetail,
        available = detailAvailability(name, settings.type, map.getZoom());
      button.disabled = !available.available;
      button.setAttribute(
        "aria-pressed",
        String(Boolean(settings.details[name] && available.available)),
      );
      button.title = available.reason;
      $(`${name}-note`).textContent = available.reason;
    }
  }
  function applyDetails() {
    const effective = (name) =>
      settings.details[name] &&
      detailAvailability(name, settings.type, map.getZoom()).available;
    visibility("lk-detail-transit", effective("transit"));
    // Stops share the normal place markers; avoid independent permanent dots.
    visibility("lk-detail-cycling", effective("bicycling"));
    raised = effective("buildings");
    visibility("lk-detail-buildings", raised);
    for (const l of baseLayers)
      if (l["source-layer"] === "building" && l.type === "fill")
        visibility(
          l.id,
          settings.type !== "satellite" &&
            !raised &&
            l.layout?.visibility !== "none",
        );
    for (const id of ["mazo-places-dot", "mazo-places-icon"])
      visibility(
        id,
        settings.places && (settings.type !== "satellite" || settings.labels),
      );
    updateUI();
  }
  function apply() {
    applyAppearance();
    applyDetails();
  }
  addOverlays();
  for (const button of document.querySelectorAll("[data-theme-choice]"))
    button.onclick = () => {
      settings.theme = button.dataset.themeChoice;
      persist();
      apply();
    };
  for (const button of document.querySelectorAll("[data-map-type]"))
    button.onclick = () => {
      settings.type = button.dataset.mapType;
      persist();
      apply();
      if (settings.type === "satellite" && map.getPitch())
        map.easeTo({ pitch: 0, duration: 350 });
      else if (raised && map.getPitch() === 0)
        map.easeTo({ pitch: 45, duration: 350 });
    };
  for (const button of document.querySelectorAll("[data-map-detail]"))
    button.onclick = () => {
      const name = button.dataset.mapDetail;
      if (!detailAvailability(name, settings.type, map.getZoom()).available)
        return;
      settings.details[name] = !settings.details[name];
      if (
        settings.details[name] &&
        ["transit", "bicycling", "traffic"].includes(name)
      ) {
        for (const other of ["transit", "bicycling", "traffic"])
          if (other !== name) settings.details[other] = false;
      }
      persist();
      applyDetails();
      if (name === "buildings")
        map.easeTo({ pitch: raised ? 45 : 0, duration: 400 });
    };
  $("show-places").onchange = (e) => {
    settings.places = e.target.checked;
    persist();
    applyDetails();
  };
  $("satellite-labels").onchange = (e) => {
    settings.labels = e.target.checked;
    persist();
    apply();
  };
  $("layers").onclick = () => {
    $("layer-panel").hidden = !$("layer-panel").hidden;
    $("layers").setAttribute("aria-expanded", String(!$("layer-panel").hidden));
  };
  $("close-layers").onclick = () => {
    $("layer-panel").hidden = true;
    $("layers").setAttribute("aria-expanded", "false");
    $("layers").focus();
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("layer-panel").hidden = true;
      $("layers").setAttribute("aria-expanded", "false");
    }
  });
  media.addEventListener("change", () => {
    if (settings.theme === "system") apply();
  });
  map.on("zoom", applyDetails);
  apply();
  if (raised && map.getPitch() === 0) map.jumpTo({ pitch: 45 });
  return {
    handleError(event) {
      const message = String(event.error?.message || "");
      const type =
        event.sourceId === "lk-satellite" ||
        message.includes("services.arcgisonline.com")
          ? "satellite"
          : event.sourceId === "lk-elevation" ||
              message.includes("elevation-tiles-prod")
            ? "terrain"
            : null;
      if (!type) return false;
      failures.add(type);
      if (settings.type === type) {
        settings.type = "default";
        lastAppearance = "";
        persist();
        apply();
        status(
          `${type === "satellite" ? "Satellite" : "Terrain"} provider unavailable. Switched to Default.`,
        );
      }
      return true;
    },
  };
}
