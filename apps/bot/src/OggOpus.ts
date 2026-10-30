import { Array } from "effect";

export const OPUS_SAMPLE_RATE = 48_000;

const CRC_TABLE = new Uint32Array(256);

for (let index = 0; index < 256; index += 1) {
  let value = index << 24;

  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 0x80000000) === 0 ? value << 1 : (value << 1) ^ 0x04c11db7;
  }

  CRC_TABLE[index] = value >>> 0;
}

export const oggChecksum = (page: Uint8Array): number => {
  let crc = 0;

  for (const byte of page) {
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) & 0xff) ^ byte] ?? 0)) >>> 0;
  }

  return crc;
};

const FRAME_SIZES_MS = [10, 20, 40, 60];

const frameDurationMs = (config: number): number => {
  if (config < 12) return FRAME_SIZES_MS[config & 0x03] ?? 20;

  if (config < 16) return (config & 0x01) === 0 ? 10 : 20;

  return 2.5 * 2 ** (config & 0x03);
};

const framesInPacket = (packet: Uint8Array, frameCode: number): number => {
  if (frameCode === 0) return 1;

  if (frameCode === 3) return (packet[1] ?? 0) & 0x3f;

  return 2;
};

export const opusPacketSamples = (packet: Uint8Array): number => {
  const toc = packet[0];

  if (toc === undefined) return 0;

  const config = toc >> 3;
  const frameCode = toc & 0x03;

  return (
    Math.round((frameDurationMs(config) * OPUS_SAMPLE_RATE) / 1000) *
    framesInPacket(packet, frameCode)
  );
};

export const opusPacketsDuration = (packets: ReadonlyArray<Uint8Array>): number => {
  let samples = 0;

  for (const packet of packets) samples += opusPacketSamples(packet);

  return Math.round((samples * 1000) / OPUS_SAMPLE_RATE);
};

const CHANNELS = 2;

const PRE_SKIP = 312;

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

const opusHead = (): Uint8Array => {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);

  head.set(ascii("OpusHead"), 0);
  head[8] = 1;
  head[9] = CHANNELS;
  view.setUint16(10, PRE_SKIP, true);
  view.setUint32(12, OPUS_SAMPLE_RATE, true);
  view.setInt16(16, 0, true);
  head[18] = 0;

  return head;
};

const opusTags = (): Uint8Array => {
  const vendor = ascii("virtual-office-notifier");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(tags.buffer);

  tags.set(ascii("OpusTags"), 0);
  view.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true);

  return tags;
};

const MAX_SEGMENTS = 255;

const segmentsOf = (packet: Uint8Array): Array<number> => {
  const lacing: Array<number> = [];
  let remaining = packet.length;

  while (remaining >= 255) {
    lacing.push(255);
    remaining -= 255;
  }

  lacing.push(remaining);

  return lacing;
};

interface PageInput {
  readonly packets: ReadonlyArray<Uint8Array>;
  readonly granulePosition: bigint;
  readonly serial: number;
  readonly sequence: number;
  readonly first: boolean;
  readonly last: boolean;
}

const oggPage = ({
  packets,
  granulePosition,
  serial,
  sequence,
  first,
  last,
}: PageInput): Uint8Array => {
  const lacing = Array.flatMap(packets, segmentsOf);
  const bodyLength = Array.reduce(packets, 0, (total, packet) => total + packet.length);
  const page = new Uint8Array(27 + lacing.length + bodyLength);
  const view = new DataView(page.buffer);

  page.set(ascii("OggS"), 0);
  page[4] = 0;
  page[5] = (first ? 0x02 : 0) | (last ? 0x04 : 0);
  view.setBigUint64(6, granulePosition, true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  view.setUint32(22, 0, true);
  page[26] = lacing.length;
  page.set(lacing, 27);

  let offset = 27 + lacing.length;

  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }

  view.setUint32(22, oggChecksum(page), true);

  return page;
};

const PACKETS_PER_PAGE = 50;

const groupIntoPages = (
  packets: ReadonlyArray<Uint8Array>,
): ReadonlyArray<ReadonlyArray<Uint8Array>> => {
  const groups: Array<ReadonlyArray<Uint8Array>> = [];
  let current: Array<Uint8Array> = [];
  let segments = 0;

  for (const packet of packets) {
    const needed = segmentsOf(packet).length;

    if (
      current.length > 0 &&
      (segments + needed > MAX_SEGMENTS || current.length >= PACKETS_PER_PAGE)
    ) {
      groups.push(current);
      current = [];
      segments = 0;
    }

    current.push(packet);
    segments += needed;
  }

  groups.push(current);

  return groups;
};

export const oggOpusFile = (
  packets: ReadonlyArray<Uint8Array>,
  serial = 0x4f464643,
): Uint8Array => {
  const pages: Array<Uint8Array> = [
    oggPage({
      packets: [opusHead()],
      granulePosition: 0n,
      serial,
      sequence: 0,
      first: true,
      last: false,
    }),
    oggPage({
      packets: [opusTags()],
      granulePosition: 0n,
      serial,
      sequence: 1,
      first: false,
      last: false,
    }),
  ];

  const groups = groupIntoPages(packets);
  let granule = 0n;

  Array.forEach(groups, (group, index) => {
    for (const packet of group) granule += BigInt(opusPacketSamples(packet));

    pages.push(
      oggPage({
        packets: group,
        granulePosition: granule,
        serial,
        sequence: 2 + index,
        first: false,
        last: index === groups.length - 1,
      }),
    );
  });

  const file = new Uint8Array(Array.reduce(pages, 0, (total, page) => total + page.length));
  let offset = 0;

  for (const page of pages) {
    file.set(page, offset);
    offset += page.length;
  }

  return file;
};
