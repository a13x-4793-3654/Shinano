import type { ShinanoAPI } from '../shared/model.ts';

declare global {
  interface Window {
    shinano: ShinanoAPI;
  }

  interface BarcodeDetectorResult {
    rawValue: string;
  }

  class BarcodeDetector {
    constructor(options?: { formats?: string[] });
    detect(source: ImageBitmapSource): Promise<BarcodeDetectorResult[]>;
  }
}
