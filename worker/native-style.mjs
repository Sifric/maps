import { darkMapStyle } from './public/map-options.js';

export function nativeStyle(base, parameters) {
  const type = parameters.get('type') ?? 'default';
  const theme = parameters.get('theme') ?? 'light';
  if (!['default', 'satellite', 'terrain'].includes(type) || !['light', 'dark'].includes(theme)) return null;
  const style = theme === 'dark' ? darkMapStyle(base) : base;
  if (type === 'satellite') {
    style.sources.imagery = {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Imagery © Esri and its contributors',
    };
    style.layers = style.layers.filter(layer =>
      ['background', 'symbol'].includes(layer.type) && !layer.id.includes('one_way_arrow'));
    const index = style.layers.findIndex(layer => layer.type !== 'background');
    style.layers.splice(index < 0 ? style.layers.length : index, 0, {
      id: 'sifric-imagery', type: 'raster', source: 'imagery',
      paint: { 'raster-brightness-max': theme === 'dark' ? 0.72 : 1 },
    });
  }
  if (type === 'terrain') {
    style.sources.relief = {
      type: 'raster-dem', tileSize: 256, maxzoom: 14, encoding: 'terrarium',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      attribution: 'Mapzen / AWS Open Data',
    };
    const index = style.layers.findIndex(layer => layer.type === 'line');
    style.layers.splice(index < 0 ? style.layers.length : index, 0, {
      id: 'sifric-hillshade', type: 'hillshade', source: 'relief',
      paint: { 'hillshade-exaggeration': 0.5 },
    });
  }
  if (type !== 'satellite' && style.sources.openmaptiles) {
    const index = style.layers.findIndex(layer => layer.type === 'symbol');
    style.layers.splice(index < 0 ? style.layers.length : index, 0, {
      id: 'sifric-native-buildings', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building',
      minzoom: 15,
      filter: ['all', ['!=', ['get', 'hide_3d'], true], ['>', ['coalesce', ['get', 'render_height'], 0], 0]],
      paint: {
        'fill-extrusion-color': theme === 'dark' ? '#3e4855' : '#d4dce4',
        'fill-extrusion-height': ['max', 0, ['coalesce', ['get', 'render_height'], 0]],
        'fill-extrusion-base': ['max', 0, ['coalesce', ['get', 'render_min_height'], 0]],
        'fill-extrusion-opacity': 0.92,
      },
    });
  }
  return style;
}
