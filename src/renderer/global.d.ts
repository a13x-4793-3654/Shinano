import type { ShinanoAPI } from '../shared/model.ts';

declare global {
  interface Window {
    shinano: ShinanoAPI;
  }
}
