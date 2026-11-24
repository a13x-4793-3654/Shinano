import assert from 'node:assert/strict';
import { test } from 'node:test';
import QRCode from 'qrcode';
import { readTotpQr } from '../../src/main/totp-qr.ts';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // Public RFC 6238 key.
const uri = `otpauth://totp/Synthetic%3Afixture?secret=${secret}&issuer=Synthetic&algorithm=SHA256`;

function bitmap(values: string[], inverted = false) {
  const codes = values.map((value) => QRCode.create(value, { errorCorrectionLevel: 'M' }));
  const scale = 5;
  const cell = Math.max(...codes.map((qr) => qr.modules.size)) + 12;
  const width = cell * scale * codes.length;
  const height = cell * scale;
  const data = new Uint8Array(width * height * 4).fill(inverted ? 0 : 255);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  codes.forEach((qr, index) => {
    for (let y = 0; y < qr.modules.size; y++) {
      for (let x = 0; x < qr.modules.size; x++) {
        if (!qr.modules.get(y, x)) continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
          const offset = (((y + 6) * scale + dy) * width + (index * cell + x + 6) * scale + dx) * 4;
          data.fill(inverted ? 255 : 0, offset, offset + 3);
        }
      }
    }
  });
  return { data, width, height };
}

test('QR bitmaps import standard TOTP metadata and the exact key, including inverted QR', () => {
  for (const inverted of [false, true]) {
    const image = bitmap([uri], inverted);
    const original = image.data.slice();
    const parsed = readTotpQr(image.data, image.width, image.height);
    try {
      assert.equal(parsed.key.toString(), '12345678901234567890');
      assert.deepEqual(parsed.metadata, {
        issuer: 'Synthetic', account: 'fixture', algorithm: 'SHA256', digits: 6, period: 30,
      });
      assert.deepEqual(image.data, original);
    } finally {
      parsed.key.fill(0);
    }
  }
});

test('QR import rejects multiple codes, unsupported enrollment and malformed TOTP without leaking payloads', () => {
  for (const [values, message] of [
    [[uri, uri], /複数/],
    [[uri, 'https://example.test/activation/synthetic'], /複数/],
    [['https://example.test/activation/synthetic'], /TOTP 登録用/],
    [[secret], /TOTP 登録用/],
    [[`${uri}&digits=8`], /形式または設定/],
    [[`${uri}&secret=duplicate`], /形式または設定/],
  ] as const) {
    const image = bitmap([...values]);
    assert.throws(() => readTotpQr(image.data, image.width, image.height), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, message);
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes('https://example.test'));
      return true;
    });
  }
});

test('QR import reports blank images and rejects invalid or oversized image dimensions', () => {
  assert.throws(() => readTotpQr(new Uint8Array(100 * 100 * 4).fill(255), 100, 100), /見つかりません/);
  for (const [width, height] of [[0, 1], [1.5, 1], [Infinity, 1], [4001, 4000], [2, 2]]) {
    assert.throws(() => readTotpQr(new Uint8Array(4), width!, height!), /画像を読み取れません/);
  }
});
