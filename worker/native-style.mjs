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
    style.layers = style.layers.filter(layer => ['background', 'symbol'].includes(layer.type));
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
  return style;
}
