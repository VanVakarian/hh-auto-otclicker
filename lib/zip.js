// A ZIP archive with no compression ("stored" entries): the only thing zipped here is PNG, which is
// compressed already, so deflate would cost code for nothing. `files` is [{ name, data: Uint8Array }],
// names ASCII; returns a Blob.

const DOS_DATE_1980_01_01 = (1 << 5) | 1;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// little-endian fields laid out one after another, each a [byte length (2 or 4), value] pair
function pack(...fields) {
  const view = new DataView(new ArrayBuffer(fields.reduce((sum, [size]) => sum + size, 0)));
  let offset = 0;
  for (const [size, value] of fields) {
    if (size === 2) view.setUint16(offset, value, true);
    else view.setUint32(offset, value, true);
    offset += size;
  }
  return view;
}

export function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let localSize = 0;
  let centralSize = 0;

  for (const { name, data } of files) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);

    localParts.push(
      pack(
        [4, 0x04034b50], // local file header signature
        [2, 10], // version needed
        [2, 0], // flags
        [2, 0], // method: stored
        [2, 0], // time
        [2, DOS_DATE_1980_01_01],
        [4, crc],
        [4, data.length], // compressed size
        [4, data.length], // uncompressed size
        [2, nameBytes.length],
        [2, 0], // extra field length
      ),
      nameBytes,
      data,
    );

    centralParts.push(
      pack(
        [4, 0x02014b50], // central directory header signature
        [2, 10], // version made by
        [2, 10], // version needed
        [2, 0], // flags
        [2, 0], // method: stored
        [2, 0], // time
        [2, DOS_DATE_1980_01_01],
        [4, crc],
        [4, data.length],
        [4, data.length],
        [2, nameBytes.length],
        [2, 0], // extra field length
        [2, 0], // comment length
        [2, 0], // disk number
        [2, 0], // internal attributes
        [4, 0], // external attributes
        [4, localSize], // where this entry's local header starts
      ),
      nameBytes,
    );

    localSize += 30 + nameBytes.length + data.length;
    centralSize += 46 + nameBytes.length;
  }

  const end = pack(
    [4, 0x06054b50], // end of central directory signature
    [2, 0], // this disk
    [2, 0], // disk with the central directory
    [2, files.length],
    [2, files.length],
    [4, centralSize],
    [4, localSize], // where the central directory starts
    [2, 0], // comment length
  );

  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}
