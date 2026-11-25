import jsQR from 'jsqr';
import { parseTotpImport, type ParsedTotp } from './totp.ts';
import { UserError } from '../shared/validation.ts';

const MAX_PIXELS = 16_000_000;
const QR_HELP = 'Entra ID では「別の認証アプリを使用する」で TOTP 用 QR を表示してください。Microsoft Authenticator 専用の QR は使用できません。';

interface LocatedQr {
  data: string;
  corners: { x: number; y: number }[];
}

function locateQr(rgba: Uint8ClampedArray, width: number, height: number): LocatedQr | null {
  const scan = (pixels: Uint8ClampedArray, w: number, h: number, x = 0, y = 0): LocatedQr | null => {
    const qr = jsQR(pixels, w, h, { inversionAttempts: 'attemptBoth' });
    return qr ? {
      data: qr.data,
      corners: [qr.location.topLeftCorner, qr.location.topRightCorner,
        qr.location.bottomLeftCorner, qr.location.bottomRightCorner]
        .map((point) => ({ x: point.x + x, y: point.y + y })),
    } : null;
  };
  const whole = scan(rgba, width, height);
  if (whole || width < 80 || height < 80) return whole;
  // Multiple finder-pattern groups can confuse a single-image decoder.
  const halfWidth = Math.ceil(width / 2);
  const halfHeight = Math.ceil(height / 2);
  const xs = [0, Math.floor((width - halfWidth) / 2), width - halfWidth];
  const ys = [0, Math.floor((height - halfHeight) / 2), height - halfHeight];
  const regions = [
    ...Array.from({ length: 7 }, (_, index) => ({
      x: Math.floor((width - Math.ceil(width / 4)) * index / 6),
      y: 0, w: Math.ceil(width / 4), h: height,
    })),
    ...xs.map((x) => ({ x, y: 0, w: halfWidth, h: height })),
    ...ys.map((y) => ({ x: 0, y, w: width, h: halfHeight })),
    ...xs.flatMap((x) => ys.map((y) => ({ x, y, w: halfWidth, h: halfHeight }))),
  ];
  for (const { x, y, w, h } of regions) {
    const pixels = new Uint8ClampedArray(w * h * 4);
    try {
      for (let row = 0; row < h; row++) {
        const start = ((y + row) * width + x) * 4;
        pixels.set(rgba.subarray(start, start + w * 4), row * w * 4);
      }
      const qr = scan(pixels, w, h, x, y);
      if (qr) return qr;
    } finally {
      pixels.fill(0);
    }
  }
  return null;
}

// Electron's native bitmap uses BGRA, not the RGBA expected by the decoder.
export function readTotpQr(bitmap: Uint8Array, width: number, height: number): ParsedTotp {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width * height > MAX_PIXELS || bitmap.length !== width * height * 4) {
    throw new UserError('ページの画像を読み取れません。ウィンドウを小さくして再試行してください。');
  }
  const rgba = new Uint8ClampedArray(bitmap.length);
  try {
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      rgba[offset] = bitmap[offset + 2]!;
      rgba[offset + 1] = bitmap[offset + 1]!;
      rgba[offset + 2] = bitmap[offset]!;
      rgba[offset + 3] = bitmap[offset + 3]!;
    }
    const qr = locateQr(rgba, width, height);
    if (!qr) {
      throw new UserError(`QR コードが見つかりません。タブに戻り、QR 全体を画面内に表示して再試行してください。${QR_HELP}`);
    }
    const corners = qr.corners;
    const left = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.x))) - 2);
    const right = Math.min(width, Math.ceil(Math.max(...corners.map((point) => point.x))) + 2);
    const top = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.y))) - 2);
    const bottom = Math.min(height, Math.ceil(Math.max(...corners.map((point) => point.y))) + 2);
    for (let y = top; y < bottom; y++) rgba.fill(255, (y * width + left) * 4, (y * width + right) * 4);
    if (locateQr(rgba, width, height)) {
      throw new UserError('複数の QR コードが見つかりました。対象の QR だけを画面内に表示して再試行してください。');
    }
    if (!/^otpauth:\/\/totp\//i.test(qr.data)) {
      throw new UserError(`この QR コードは TOTP 登録用ではありません。${QR_HELP}`);
    }
    return parseTotpImport(qr.data);
  } finally {
    rgba.fill(0);
  }
}
