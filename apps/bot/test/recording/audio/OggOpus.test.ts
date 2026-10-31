import { assert, describe, it } from "@effect/vitest";
import { Array } from "effect";

import {
  oggChecksum,
  oggOpusFile,
  opusPacketSamples,
  opusPacketsDuration,
} from "../../../src/recording/audio/OggOpus.ts";

// A 20 ms CELT fullband stereo packet, as Discord sends: config 31, stereo, one frame.
const celt20ms = (fill = 0xab): Uint8Array => new Uint8Array([0b1111_1100, fill, fill, fill]);

const text = (bytes: Uint8Array, start: number, length: number): string =>
  new TextDecoder().decode(bytes.subarray(start, start + length));

const pageHeaders = (file: Uint8Array) => {
  const headers: Array<{
    offset: number;
    flags: number;
    granule: bigint;
    sequence: number;
    segments: number;
  }> = [];

  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let offset = 0;

  while (offset < file.length) {
    assert.strictEqual(text(file, offset, 4), "OggS");

    const segments = file[offset + 26] ?? 0;

    const body = Array.reduce(
      file.subarray(offset + 27, offset + 27 + segments),
      0,
      (total, lace) => total + lace,
    );

    headers.push({
      offset,
      flags: file[offset + 5] ?? 0,
      granule: view.getBigUint64(offset + 6, true),
      sequence: view.getUint32(offset + 18, true),
      segments,
    });

    offset += 27 + segments + body;
  }

  return headers;
};

describe("opusPacketSamples", () => {
  it("reads the frame size from the table-of-contents byte", () => {
    assert.strictEqual(opusPacketSamples(celt20ms()), 960);
    assert.strictEqual(opusPacketSamples(new Uint8Array([0b0001_1000])), 2880);
    assert.strictEqual(opusPacketSamples(new Uint8Array([0b0111_1000])), 960);
    assert.strictEqual(opusPacketSamples(new Uint8Array([0b1100_0000])), 120);
    assert.strictEqual(opusPacketSamples(new Uint8Array([0b0010_1110])), 1920);
    assert.strictEqual(opusPacketSamples(new Uint8Array([0b0010_1111, 3])), 2880);
    assert.strictEqual(opusPacketSamples(new Uint8Array([0b0010_0100])), 480);
    assert.strictEqual(opusPacketSamples(new Uint8Array([])), 0);
  });

  it("adds the packets up to a duration in milliseconds", () => {
    assert.strictEqual(opusPacketsDuration([celt20ms(), celt20ms(), celt20ms()]), 60);
  });
});

// The Ogg CRC: polynomial 0x04c11db7, no reflection, no initial value, no
// final XOR. Computed bit by bit here, so the table in the muxer is checked
// against something independent.
const bitwiseChecksum = (bytes: Uint8Array): number => {
  let crc = 0;

  for (const byte of bytes) {
    crc ^= byte << 24;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80000000) === 0 ? crc << 1 : (crc << 1) ^ 0x04c11db7;
    }
  }

  return crc >>> 0;
};

describe("oggChecksum", () => {
  it("matches a bit-by-bit Ogg CRC-32", () => {
    const samples = [
      new Uint8Array([0x4f, 0x67, 0x67, 0x53]),
      new Uint8Array(300).map((_, index) => index % 251),
      new Uint8Array(0),
    ];

    for (const sample of samples) assert.strictEqual(oggChecksum(sample), bitwiseChecksum(sample));
  });
});

describe("oggOpusFile", () => {
  it("writes the OpusHead and OpusTags pages before the audio", () => {
    const file = oggOpusFile([celt20ms(), celt20ms()]);
    const pages = pageHeaders(file);

    assert.strictEqual(pages.length, 3);
    assert.strictEqual(pages[0]?.flags, 0x02);
    assert.strictEqual(text(file, 28, 8), "OpusHead");
    assert.strictEqual(pages[1]?.flags, 0);
    assert.strictEqual(text(file, (pages[1]?.offset ?? 0) + 28, 8), "OpusTags");
    assert.strictEqual(pages[2]?.flags, 0x04);
    assert.strictEqual(pages[2]?.granule, 1920n);
    assert.strictEqual(pages[2]?.segments, 2);
    assert.deepStrictEqual(
      Array.map(pages, (page) => page.sequence),
      [0, 1, 2],
    );
  });

  it("stores a stereo 48 kHz header with Discord's pre-skip", () => {
    const file = oggOpusFile([celt20ms()]);
    const view = new DataView(file.buffer);

    assert.strictEqual(file[28 + 8], 1);
    assert.strictEqual(file[28 + 9], 2);
    assert.strictEqual(view.getUint16(28 + 10, true), 312);
    assert.strictEqual(view.getUint32(28 + 12, true), 48_000);
  });

  it("splits long recordings into pages of at most 50 packets", () => {
    const packets = Array.makeBy(120, () => celt20ms());
    const pages = pageHeaders(oggOpusFile(packets));

    assert.deepStrictEqual(
      Array.map(pages.slice(2), (page) => page.segments),
      [50, 50, 20],
    );
    assert.deepStrictEqual(
      Array.map(pages.slice(2), (page) => page.granule),
      [48_000n, 96_000n, 115_200n],
    );
    assert.strictEqual(pages.at(-1)?.flags, 0x04);
  });

  it("laces a packet longer than 255 bytes over several segments", () => {
    const long = new Uint8Array(600).fill(1);
    long[0] = 0b1111_1100;

    const pages = pageHeaders(oggOpusFile([long]));

    assert.strictEqual(pages[2]?.segments, 3);
  });

  it("writes an empty audio page when there are no packets", () => {
    const pages = pageHeaders(oggOpusFile([]));

    assert.strictEqual(pages.length, 3);
    assert.strictEqual(pages[2]?.segments, 0);
    assert.strictEqual(pages[2]?.flags, 0x04);
  });

  it("checksums every page", () => {
    const file = oggOpusFile([celt20ms(), celt20ms(0x01)]);

    for (const page of pageHeaders(file)) {
      const view = new DataView(file.buffer);
      const stored = view.getUint32(page.offset + 22, true);
      const segments = file[page.offset + 26] ?? 0;

      const body = Array.reduce(
        file.subarray(page.offset + 27, page.offset + 27 + segments),
        0,
        (a, b) => a + b,
      );

      const bytes = file.slice(page.offset, page.offset + 27 + segments + body);

      bytes.fill(0, 22, 26);

      assert.strictEqual(oggChecksum(bytes), stored);
    }
  });
});
