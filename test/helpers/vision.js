import zlib from 'node:zlib';
import { VISION_DATA_URL, VISION_LIST_URL } from '../../src/backtest/vision.js';

/** Single-entry zip (deflate), like the archive's files. */
export function makeZip(name, content) {
  const data = Buffer.from(content);
  const body = zlib.deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
  cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(0, 42);
  const cenOffset = local.length + nameBuf.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cen.length + nameBuf.length, 12); eocd.writeUInt32LE(cenOffset, 16);
  return Buffer.concat([local, nameBuf, body, cen, nameBuf, eocd]);
}

const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * Fake data.binance.vision. files: { 'data/futures/um/...zip': csvText }.
 * Listings follow S3 v1 semantics (prefix, delimiter, marker), pageSize keys per page.
 * Returns { http, requests }.
 */
export function fakeVision(files = {}, { pageSize = 1000, extraKeys = [] } = {}) {
  const allKeys = [...new Set([...Object.keys(files), ...extraKeys])].sort();
  const requests = [];
  const http = async (url) => {
    requests.push(url);
    if (url.startsWith(VISION_LIST_URL)) {
      const q = new URL(url).searchParams;
      const prefix = q.get('prefix') || '', delimiter = q.get('delimiter'), marker = q.get('marker') || '';
      const entries = [];
      for (const k of allKeys) {
        if (!k.startsWith(prefix) || k <= marker) continue;
        const rest = k.slice(prefix.length);
        if (delimiter && rest.includes(delimiter)) {
          const p = prefix + rest.slice(0, rest.indexOf(delimiter) + 1);
          if (p > marker && !entries.some(e => e.prefix === p)) entries.push({ prefix: p });
        } else entries.push({ key: k });
      }
      const page = entries.slice(0, pageSize);
      const truncated = entries.length > pageSize;
      const last = page.at(-1);
      const xml = `<?xml version="1.0"?><ListBucketResult><Prefix>${xmlEscape(prefix)}</Prefix><IsTruncated>${truncated}</IsTruncated>` +
        (truncated && delimiter ? `<NextMarker>${xmlEscape(last.key || last.prefix)}</NextMarker>` : '') +
        page.filter(e => e.key).map(e => `<Contents><Key>${xmlEscape(e.key)}</Key><Size>1</Size></Contents>`).join('') +
        page.filter(e => e.prefix).map(e => `<CommonPrefixes><Prefix>${xmlEscape(e.prefix)}</Prefix></CommonPrefixes>`).join('') +
        '</ListBucketResult>';
      return { status: 200, data: Buffer.from(xml) };
    }
    const key = url.slice(VISION_DATA_URL.length + 1);
    if (!(key in files)) return { status: 404, data: Buffer.alloc(0) };
    return { status: 200, data: makeZip(key.split('/').at(-1).replace('.zip', '.csv'), files[key]) };
  };
  return { http, requests };
}

/** Kline CSV rows for candles { openTime, open, high, low, close, volume, closeTime, quoteVolume }. */
export function klineCsv(candles, { header = true } = {}) {
  const head = header ? 'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n' : '';
  return head + candles.map(k => [k.openTime, k.open, k.high, k.low, k.close, k.volume, k.closeTime, k.quoteVolume, 1, 0, 0, 0].join(',')).join('\n');
}
