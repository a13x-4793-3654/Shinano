import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeBase32, hotp, parseTotpImport, totpAt } from '../../src/main/totp.ts';
import {
  MAX_TOTP_INPUT_LENGTH, MAX_TOTP_LABEL_LENGTH, MAX_TOTP_SECRET_BYTES,
  type TotpAlgorithm,
} from '../../src/shared/totp.ts';
import { UserError } from '../../src/shared/validation.ts';

// Public RFC 4226/6238 reference seeds and synthetic labels only; these are not credentials.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_KEYS: Record<TotpAlgorithm, Buffer> = {
  SHA1: Buffer.from('12345678901234567890', 'ascii'),
  SHA256: Buffer.from('12345678901234567890123456789012', 'ascii'),
  SHA512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii'),
};
const DEFAULT_METADATA = { algorithm: 'SHA1', digits: 6, period: 30, issuer: null, account: null } as const;
const URI = `otpauth://totp/fixture%40example.test?secret=${RFC_SECRET}`;

function fixtureUri(encodedLabel: string, query = `secret=${RFC_SECRET}`): string {
  return `otpauth://totp/${encodedLabel}?${query}`;
}

function rejectsImport(values: readonly unknown[]): void {
  for (const value of values) assert.throws(() => parseTotpImport(value), UserError);
}

test('Base32 decodes the public RFC 4648 examples, padded or unpadded in either ASCII case', () => {
  for (const [plain, encoded] of [
    ['f', 'MY======'], ['fo', 'MZXQ===='], ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI======'],
  ]) {
    for (const value of [encoded!, encoded!.toLowerCase(), encoded!.replaceAll('=', '')]) {
      assert.deepEqual(decodeBase32(value), Buffer.from(plain!, 'ascii'));
    }
  }
  assert.deepEqual(decodeBase32(RFC_SECRET), RFC_KEYS.SHA1);
});

test('Base32 space grouping is opt-in and removes only literal ASCII spaces', () => {
  assert.deepEqual(decodeBase32('  m y = = = = = =  ', true), Buffer.from('f'));
  assert.throws(() => decodeBase32('MY '), UserError);
  for (const separator of ['-', '\t', '\n', '\r', '\u0000', '\u007f', '\u0085', '\u00a0', '\u2009', '\u2028', '\ufeff']) {
    assert.throws(() => decodeBase32(`M${separator}Y`, true), UserError);
    assert.throws(() => decodeBase32(`MY${separator}`, true), UserError);
  }
});

test('Base32 rejects aliases, non-ASCII letters, wrong types, empty input and invalid lengths', () => {
  for (const value of [
    null, undefined, [], {}, 42, new String('MY'), Buffer.from('MY'),
    '', ' ', 'A', 'AAA', 'AAAAAA', 'AAAAAAAAA', 'M0', 'M1', 'M8', 'M9', 'M-Y',
    'ＭＹ', 'Mſ', 'Mı', 'KY', 'M.Y', 'MY\n',
  ]) {
    assert.throws(() => decodeBase32(value), UserError);
    assert.throws(() => decodeBase32(value, true), UserError);
  }
  assert.throws(() => decodeBase32('M Y', 'true' as unknown as boolean), UserError);
});

test('Base32 requires exact trailing padding and zero unused bits', () => {
  for (const value of [
    '=', '======', '=MY', 'M=Y======', 'MY======A',
    'MY=', 'MY=====', 'MY=======', 'MY========',
    'MZXQ===', 'MZXW6==', 'MZXW6YQ==', 'MZXW6YTB=', 'MZXW6YTB========',
    'MZ', 'MZ======', 'MZXR', 'MZXR====', 'MZXW7', 'MZXW7===', 'MZXW6YR', 'MZXW6YR=',
  ]) {
    assert.throws(() => decodeBase32(value), UserError);
  }
});

test('Base32 enforces the raw input bound before grouping and the decoded byte bound', () => {
  const maximum = 'A'.repeat(205);
  assert.deepEqual(decodeBase32(maximum), Buffer.alloc(MAX_TOTP_SECRET_BYTES));
  assert.deepEqual(decodeBase32(`${maximum}===`), Buffer.alloc(MAX_TOTP_SECRET_BYTES));
  assert.deepEqual(decodeBase32(`${' '.repeat(MAX_TOTP_INPUT_LENGTH - 2)}AA`, true), Buffer.alloc(1));
  for (const value of ['A'.repeat(207), 'A'.repeat(208), `${' '.repeat(MAX_TOTP_INPUT_LENGTH - 1)}AA`]) {
    assert.throws(() => decodeBase32(value, true), UserError);
  }
});

test('bare Base32 import returns only the decoded key and fixed default metadata', () => {
  assert.deepEqual(parseTotpImport('  gezd gnbv gy3t qojq gezd gnbv gy3t qojq  '), {
    key: RFC_KEYS.SHA1, metadata: DEFAULT_METADATA,
  });
  assert.deepEqual(parseTotpImport('MY======'), { key: Buffer.from('f'), metadata: DEFAULT_METADATA });
});

test('URI import defaults settings and preserves the decoded account without inventing an issuer', () => {
  assert.deepEqual(parseTotpImport(URI), {
    key: RFC_KEYS.SHA1, metadata: { ...DEFAULT_METADATA, account: 'fixture@example.test' },
  });
  assert.deepEqual(parseTotpImport(fixtureUri('fixture%2Btag%40example.test', 'secret=MY%3D%3D%3D%3D%3D%3D')), {
    key: Buffer.from('f'), metadata: { ...DEFAULT_METADATA, account: 'fixture+tag@example.test' },
  });
});

test('URI scheme and type are case-insensitive and encoded label separators accept leading account spaces', () => {
  const value = `  OtPaUtH://ToTp/Public%20Fixture%3a%20%20fixture%40example.test?issuer=Public+Fixture&secret=${RFC_SECRET.toLowerCase()}&algorithm=SHA256&digits=6&period=30  `;
  assert.deepEqual(parseTotpImport(value), {
    key: RFC_KEYS.SHA1,
    metadata: { algorithm: 'SHA256', digits: 6, period: 30, issuer: 'Public Fixture', account: 'fixture@example.test' },
  });
  assert.deepEqual(parseTotpImport(fixtureUri('Public:fixture')), {
    key: RFC_KEYS.SHA1, metadata: { ...DEFAULT_METADATA, issuer: 'Public', account: 'fixture' },
  });
});

test('URI import accepts each supported algorithm and a query issuer without a label prefix', () => {
  for (const algorithm of ['SHA1', 'SHA256', 'SHA512'] as const) {
    assert.deepEqual(parseTotpImport(fixtureUri('fixture', `issuer=Public&algorithm=${algorithm}&secret=${RFC_SECRET}`)), {
      key: RFC_KEYS.SHA1, metadata: { ...DEFAULT_METADATA, algorithm, issuer: 'Public', account: 'fixture' },
    });
  }
  assert.deepEqual(parseTotpImport(fixtureUri('Public%2BFixture:fixture', `secret=${RFC_SECRET}&issuer=Public%2BFixture`)), {
    key: RFC_KEYS.SHA1, metadata: { ...DEFAULT_METADATA, issuer: 'Public+Fixture', account: 'fixture' },
  });
});

test('URI labels are UTF-8 decoded once and encoded path punctuation is label data', () => {
  const issuer = '公開テスト';
  const account = '利用者@example.test';
  assert.deepEqual(parseTotpImport(fixtureUri(encodeURIComponent(`${issuer}:${account}`), `secret=${RFC_SECRET}&issuer=${encodeURIComponent(issuer)}`)), {
    key: RFC_KEYS.SHA1, metadata: { ...DEFAULT_METADATA, issuer, account },
  });
  assert.equal(parseTotpImport(fixtureUri('fixture%2F%3F%23%253A')).metadata.account, 'fixture/?#%3A');
  assert.equal(parseTotpImport(fixtureUri('..')).metadata.account, '..');
});

test('URI import rejects alternate schemes, HOTP, ambiguous authorities, missing labels and fragments', () => {
  rejectsImport([
    URI.replace('otpauth:', 'https:'), URI.replace('totp/', 'hotp/'),
    URI.replace('://', ':/'), URI.replace('://', ':'),
    URI.replace('://', ':///'), URI.replace('otpauth:', ''),
    URI.replace('totp/', 'totp:/'), URI.replace('totp/', 'totp:443/'),
    URI.replace('totp/', 'fixture@totp/'), URI.replace('totp/', 'fixture:fixture@totp/'),
    URI.replace('totp/', '@totp/'), URI.replace('totp/', 'totp./'),
    URI.replace('totp/', 'totp.example.test/'), URI.replace('totp/', '%74otp/'),
    URI.replace('totp/', 'totp%3A/'), URI.replace('totp/', 'TOTＰ/'),
    fixtureUri(''), fixtureUri('/fixture'), fixtureUri('a/b'),
    fixtureUri('../fixture'), fixtureUri('./fixture'),
    `otpauth://totp?secret=${RFC_SECRET}`, 'otpauth://totp/fixture', 'otpauth://totp/fixture?',
    `${URI}#`, `${URI}#fixture`, fixtureUri('fixture#label'),
    URI.replace('totp/', 'totp\\'), fixtureUri('fixture\\label'), fixtureUri('fixture label'),
  ]);
});

test('URI import rejects controls, malformed percent escapes and invalid UTF-8 in all components', () => {
  for (const value of ['%', '%0', '%GG', '%G0', '%u0041', '%80', '%C0%AF', '%E3%81', '%ED%A0%80', '%F4%90%80%80']) {
    rejectsImport([
      fixtureUri(value),
      fixtureUri('fixture', `secret=${RFC_SECRET}&issuer=${value}`),
      fixtureUri('fixture', `secret=${value}`),
      fixtureUri('fixture', `${value}=${RFC_SECRET}`),
    ]);
  }
  for (const control of ['\u0000', '\t', '\n', '\r', '\u001f', '\u007f', '\u0085', '\u200b', '\u2028', '\u2029', '\u202e', '\u2066', '\ufeff']) {
    rejectsImport([
      `${control}${URI}`, `${URI}${control}`, fixtureUri(`fixture${control}`),
      fixtureUri(`fixture${encodeURIComponent(control)}`),
      fixtureUri('fixture', `secret=${RFC_SECRET}&issuer=Public${encodeURIComponent(control)}`),
    ]);
  }
  rejectsImport([`\u00a0${URI}`, `${URI}\ufeff`, fixtureUri('\ud800'), fixtureUri('公開')]);
});

test('URI query fields must be nonempty, allowed, and unique after decoding', () => {
  for (const query of [
    'issuer=Public', 'secret', 'secret=', `=${RFC_SECRET}`, `Secret=${RFC_SECRET}`,
    `&secret=${RFC_SECRET}`, `secret=${RFC_SECRET}&`, `secret=${RFC_SECRET}&&issuer=Public`,
    `secret=${RFC_SECRET}&secret=${RFC_SECRET}`, `secret=${RFC_SECRET}&%73ecret=${RFC_SECRET}`,
    `secret=${RFC_SECRET}&secr%65t=${RFC_SECRET}`,
    ...['issuer=Public', 'algorithm=SHA1', 'digits=6', 'period=30'].map((field) => `secret=${RFC_SECRET}&${field}&${field}`),
    ...['issuer=', 'algorithm=', 'digits=', 'period=', 'counter=0', 't0=0', 'image=https%3A%2F%2Fexample.test%2Ffixture.png', 'unknown=fixture', 'Algorithm=SHA1'].map((field) => `secret=${RFC_SECRET}&${field}`),
    `secret=${RFC_SECRET}&issuer=Public&iss%75er=Public`,
  ]) {
    rejectsImport([fixtureUri('fixture', query)]);
  }
});

test('URI settings cannot silently select unsupported or noncanonical variants', () => {
  for (const [field, values] of [
    ['algorithm', ['sha1', 'SHA-1', 'SHA384', 'MD5', ' SHA1', 'SHA1 ']],
    ['digits', ['8', '06', '6.0', '6e0', '+6', ' 6', '6 ', '0', '-6']],
    ['period', ['60', '030', '30.0', '3e1', '+30', ' 30', '30 ', '0', '-30']],
  ] as const) {
    for (const value of values) rejectsImport([`${URI}&${field}=${encodeURIComponent(value)}`]);
  }
});

test('URI secrets never accept grouped whitespace, aliases or double percent decoding', () => {
  for (const secret of ['M Y', 'M%20Y', 'M+Y', 'MY%20', 'M%09Y', 'MY%0A', 'MY%00', 'M-Y', 'M0', 'M1', '%254D%2559', 'MZ']) {
    rejectsImport([fixtureUri('fixture', `secret=${secret}`)]);
  }
});

test('URI labels reject empty accounts, additional colons and unequal issuer declarations', () => {
  rejectsImport([
    fixtureUri('%20'), fixtureUri(':fixture'), fixtureUri('%3Afixture'),
    fixtureUri('Public:'), fixtureUri('Public%3A%20%20'),
    fixtureUri('Public:fixture:extra'), fixtureUri('Public%3Afixture%3Aextra'),
    `${fixtureUri('Public:fixture')}&issuer=Different`,
    `${fixtureUri('Public:fixture')}&issuer=public`,
    `${URI}&issuer=%20`, `${URI}&issuer=Public%3AExtra`,
    `${fixtureUri('Cafe%CC%81:fixture')}&issuer=Caf%C3%A9`,
  ]);
});

test('import enforces per-label, decoded-key and pre-normalization input limits', () => {
  const maximumLabel = 'a'.repeat(MAX_TOTP_LABEL_LENGTH);
  assert.deepEqual(parseTotpImport(fixtureUri(`${maximumLabel}:${maximumLabel}`, `secret=${RFC_SECRET}&issuer=${maximumLabel}`)), {
    key: RFC_KEYS.SHA1, metadata: { ...DEFAULT_METADATA, issuer: maximumLabel, account: maximumLabel },
  });
  assert.equal(parseTotpImport(fixtureUri('fixture', `secret=${'A'.repeat(205)}`)).key.length, MAX_TOTP_SECRET_BYTES);
  assert.deepEqual(parseTotpImport(`${' '.repeat(MAX_TOTP_INPUT_LENGTH - RFC_SECRET.length)}${RFC_SECRET}`).key, RFC_KEYS.SHA1);
  assert.deepEqual(parseTotpImport(`${' '.repeat(MAX_TOTP_INPUT_LENGTH - URI.length)}${URI}`).key, RFC_KEYS.SHA1);
  rejectsImport([
    fixtureUri(`${maximumLabel}a`), fixtureUri(`${maximumLabel}a:fixture`), `${URI}&issuer=${maximumLabel}a`,
    fixtureUri('fixture', `secret=${'A'.repeat(207)}`),
    `${' '.repeat(MAX_TOTP_INPUT_LENGTH - RFC_SECRET.length + 1)}${RFC_SECRET}`,
    `${' '.repeat(MAX_TOTP_INPUT_LENGTH - URI.length + 1)}${URI}`,
    null, undefined, 42, [], {}, new String(RFC_SECRET), '', '   ',
  ]);
});

test('import errors are Japanese user errors without input, label, URI or seed echoes', () => {
  const sentinel = 'PUBLIC_SYNTHETIC_SENTINEL';
  for (const value of [sentinel, fixtureUri(sentinel, `secret=${RFC_SECRET}&unknown=${sentinel}`)]) {
    assert.throws(() => parseTotpImport(value), (error: unknown) => {
      assert.ok(error instanceof UserError);
      assert.match(error.message, /[ぁ-んァ-ヶ一-龯]/u);
      for (const excluded of [value, sentinel, RFC_SECRET, 'otpauth://']) {
        assert.equal(String(error).includes(excluded), false);
      }
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('HOTP matches every public RFC 4226 six-digit vector without mutating the key', () => {
  const original = Buffer.from(RFC_KEYS.SHA1);
  const codes = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  for (const [counter, code] of codes.entries()) {
    assert.equal(hotp(RFC_KEYS.SHA1, BigInt(counter), 'SHA1'), code);
  }
  assert.deepEqual(RFC_KEYS.SHA1, original);
  const container = Buffer.concat([Buffer.from('synthetic-prefix'), RFC_KEYS.SHA1, Buffer.from('synthetic-suffix')]);
  const keyView = new Uint8Array(container.buffer, container.byteOffset + 'synthetic-prefix'.length, RFC_KEYS.SHA1.length);
  assert.equal(hotp(keyView, 0n, 'SHA1'), '755224');
});

test('all RFC 6238 SHA1/SHA256/SHA512 vectors match internal eight digits and actual six-digit TOTP', () => {
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ] as const;
  const algorithms = ['SHA1', 'SHA256', 'SHA512'] as const;
  for (const [seconds, ...codes] of vectors) {
    for (const [index, algorithm] of algorithms.entries()) {
      const expected = codes[index]!;
      const counter = BigInt(seconds) / 30n;
      assert.equal(hotp(RFC_KEYS[algorithm], counter, algorithm, 8), expected);
      assert.deepEqual(totpAt(RFC_KEYS[algorithm], algorithm, seconds * 1000), {
        code: expected.slice(-6),
        generatedAt: seconds * 1000,
        validFrom: Number(counter) * 30000,
        validUntil: (Number(counter) + 1) * 30000,
      });
    }
  }
  assert.equal(totpAt(RFC_KEYS.SHA1, 'SHA1', 1111111109000).code, '081804');
});

test('TOTP has exact exclusive 30-second bounds at the Unix epoch and each rollover', () => {
  for (const [nowMs, code, validFrom, validUntil] of [
    [0, '755224', 0, 30000],
    [29999, '755224', 0, 30000],
    [30000, '287082', 30000, 60000],
    [59999, '287082', 30000, 60000],
    [60000, '359152', 60000, 90000],
  ] as const) {
    assert.deepEqual(totpAt(RFC_KEYS.SHA1, 'SHA1', nowMs), { code, generatedAt: nowMs, validFrom, validUntil });
  }
});

test('HOTP preserves the complete unsigned 64-bit counter, including leading-zero results', () => {
  // Synthetic counters with the public RFC seed; independently checked with Python's hmac.
  for (const [counter, sixDigits, eightDigits] of [
    [0x80000000n, '197202', '04197202'],
    [0x100000000n, '999456', '55999456'],
    [0x100000001n, '108930', '39108930'],
    [0x1000000007bn, '056741', '89056741'],
    [0xffffffffffffffffn, '094451', '63094451'],
  ] as const) {
    assert.equal(hotp(RFC_KEYS.SHA1, counter, 'SHA1'), sixDigits);
    assert.equal(hotp(RFC_KEYS.SHA1, counter, 'SHA1', 8), eightDigits);
  }
});

test('TOTP supports dates past 2038 and counters larger than 32 bits without wrapping', () => {
  assert.deepEqual(totpAt(RFC_KEYS.SHA1, 'SHA1', 128849018939999), {
    code: '108930', generatedAt: 128849018939999, validFrom: 128849018910000, validUntil: 128849018940000,
  });
});

test('HOTP rejects invalid keys, counters, algorithms and digit counts with safe user errors', () => {
  for (const key of [null, undefined, '', [], {}, new Uint8Array(), Buffer.alloc(129), new Uint16Array(1), new DataView(new ArrayBuffer(1)), Object.create(Uint8Array.prototype)]) {
    assert.throws(() => hotp(key as Uint8Array, 0n, 'SHA1'), UserError);
  }
  for (const counter of [-1n, 1n << 64n, 0, 1.5, NaN, null, '0', {}]) {
    assert.throws(() => hotp(RFC_KEYS.SHA1, counter as bigint, 'SHA1'), UserError);
  }
  for (const algorithm of ['sha1', 'SHA-1', 'SHA384', 'SHA256 ', undefined, null, {}]) {
    assert.throws(() => hotp(RFC_KEYS.SHA1, 0n, algorithm as TotpAlgorithm), UserError);
    assert.throws(() => totpAt(RFC_KEYS.SHA1, algorithm as TotpAlgorithm, 0), UserError);
  }
  for (const digits of [0, 5, 7, 9, '6', NaN, null]) {
    assert.throws(() => hotp(RFC_KEYS.SHA1, 0n, 'SHA1', digits as 6 | 8), UserError);
  }
  assert.match(hotp(Buffer.alloc(1), 0n, 'SHA1'), /^\d{6}$/);
  assert.match(hotp(Buffer.alloc(MAX_TOTP_SECRET_BYTES), 0n, 'SHA512', 8), /^\d{8}$/);
});

test('TOTP rejects unsafe, noninteger or negative times and any unsafe validity bound', () => {
  const firstUnsafeWindow = Number(BigInt(Number.MAX_SAFE_INTEGER) / 30000n * 30000n);
  const lastValidTime = firstUnsafeWindow - 1;
  const result = totpAt(RFC_KEYS.SHA1, 'SHA1', lastValidTime);
  assert.deepEqual(result, {
    code: hotp(RFC_KEYS.SHA1, BigInt(lastValidTime) / 30000n, 'SHA1'),
    generatedAt: lastValidTime, validFrom: firstUnsafeWindow - 30000, validUntil: firstUnsafeWindow,
  });
  for (const nowMs of [-1, -30000, 0.1, 29999.5, NaN, Infinity, -Infinity, firstUnsafeWindow, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, '0', null, undefined, 0n, new Date(0)]) {
    assert.throws(() => totpAt(RFC_KEYS.SHA1, 'SHA1', nowMs as number), UserError);
  }
});
