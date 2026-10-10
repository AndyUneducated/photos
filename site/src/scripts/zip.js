/**
 * A minimal ZIP writer: stored entries only, no compression. AVIF is already compressed, so
 * deflate would cost time for nothing, and storing keeps this to a few dozen lines instead of a
 * dependency. Names are flagged UTF-8 so CJK album titles survive on every unzip tool that
 * matters (macOS, Windows 10+, iOS Files).
 *
 * Limits: under 65535 entries and 4 GB in total (no ZIP64). A whole gallery is capped well below
 * that by the site's storage budget.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** `2026-10-02T10:37:29` -> MS-DOS time and date words (local wall-clock, which is what we have). */
function dosStamp(takenAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(takenAt || '');
  if (!m || +m[1] < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (+m[4] << 11) | (+m[5] << 5) | (+m[6] >> 1),
    date: ((+m[1] - 1980) << 9) | (+m[2] << 5) | +m[3],
  };
}

/**
 * @param {{ name: string, data: Uint8Array, takenAt?: string }[]} entries
 * @returns {Blob}
 */
export function zip(entries) {
  if (entries.length >= 0xffff) throw new Error('Too many photos for one ZIP file');
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const { time, date } = dosStamp(entry.takenAt);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, entry.data);

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true); // made by
    record.setUint16(6, 20, true); // needed
    record.setUint16(8, 0x0800, true);
    record.setUint16(10, 0, true);
    record.setUint16(12, time, true);
    record.setUint16(14, date, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, size, true);
    record.setUint32(24, size, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.push(record.buffer, name);

    offset += 30 + name.length + size;
    if (offset > 0xffffffff) throw new Error('Too much data for one ZIP file');
  }

  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
