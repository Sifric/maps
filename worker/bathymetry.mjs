const dataKey = 'lkmaps/relief/etopo-2022-lk.bin';
const headerLength = 32;

export async function sampleRelief(bucket, lon, lat) {
  const header = await bucket.get(dataKey, { range: { offset: 0, length: headerLength } });
  if (!header) return undefined;
  const data = await header.arrayBuffer();
  if (data.byteLength !== headerLength || new TextDecoder().decode(data.slice(0, 8)) !== 'SIFRICE1') {
    throw new Error('Invalid relief grid.');
  }
  const view = new DataView(data);
  const westCenter = view.getFloat64(8, true);
  const southCenter = view.getFloat64(16, true);
  const width = view.getUint32(24, true);
  const height = view.getUint32(28, true);
  const x = Math.round((lon - westCenter) * 240);
  const y = Math.round((lat - southCenter) * 240);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= width || y >= height) return null;
  const offset = headerLength + 2 * (y * width + x);
  const sample = await bucket.get(dataKey, { range: { offset, length: 2 }, onlyIf: { etagMatches: header.etag } });
  if (!sample?.body) throw new Error('Relief grid changed during lookup.');
  const bytes = await sample.arrayBuffer();
  if (bytes.byteLength !== 2) throw new Error('Invalid relief sample.');
  const elevationMeters = new DataView(bytes).getInt16(0, true);
  return {
    elevationMeters,
    depthBelowDatumMeters: elevationMeters < 0 ? -elevationMeters : null,
    sampleLongitude: westCenter + x / 240,
    sampleLatitude: southCenter + y / 240,
    resolutionArcSeconds: 15,
    verticalDatum: 'EGM2008',
    source: 'NOAA/NCEI ETOPO 2022',
  };
}
