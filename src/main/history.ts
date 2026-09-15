import type { HistoryMode } from '../shared/library.ts';
import { historyLocation, pageTitle } from '../shared/library-validation.ts';
import { UserError } from '../shared/validation.ts';

interface Target {
  profileId: string;
  url: string;
  mode: Exclude<HistoryMode, 'off'>;
  at: number;
  title: () => string;
  alive: () => boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

type VisitWriter = (profileId: string, url: string, title: string, at: number, mode: Exclude<HistoryMode, 'off'>, current: () => boolean) => Promise<void>;

export class HistoryCapture {
  private readonly pending = new Map<string, Target>();
  private readonly locations = new Map<string, string>();
  private disposed = false;
  private readonly write: VisitWriter;
  private readonly report: (message: string) => void;
  private readonly now: () => number;

  constructor(
    write: VisitWriter,
    report: (message: string) => void,
    now: () => number = Date.now,
  ) { this.write = write; this.report = report; this.now = now; }

  committed(tabId: string, profileId: string, input: string, mode: HistoryMode, inPage: boolean, title: () => string, alive: () => boolean): void {
    if (this.disposed) return;
    const url = mode === 'off' ? null : historyLocation(input, mode);
    if (!url || mode === 'off') { this.cancel(tabId); return; }
    if (inPage && this.locations.get(tabId) === url) return;
    this.cancel(tabId);
    this.locations.set(tabId, url);
    this.pending.set(tabId, { profileId, url, mode, at: this.now(), title, alive, timer: null });
    if (inPage) this.completed(tabId);
  }

  completed(tabId: string): void {
    const target = this.pending.get(tabId);
    if (!target || this.disposed) return;
    if (target.timer) clearTimeout(target.timer);
    target.timer = setTimeout(() => {
      target.timer = null;
      const current = () => !this.disposed && this.pending.get(tabId) === target && target.alive();
      void Promise.resolve().then(async () => {
        if (!current()) return;
        const title = target.mode === 'origins' ? new URL(target.url).hostname : pageTitle(target.title(), new URL(target.url).hostname);
        await this.write(target.profileId, target.url, title, target.at, target.mode, current);
      }).catch((error: unknown) => {
        if (!this.disposed) this.report(error instanceof UserError ? error.message : '履歴を暗号化保存できませんでした。保存先と OS の鍵を確認してください。');
      }).finally(() => { if (this.pending.get(tabId) === target) this.pending.delete(tabId); });
    }, 1500);
    target.timer.unref();
  }

  cancel(tabId: string): void {
    const target = this.pending.get(tabId);
    if (target?.timer) clearTimeout(target.timer);
    this.pending.delete(tabId);
  }

  closed(tabId: string): void { this.cancel(tabId); this.locations.delete(tabId); }

  profileRemoved(profileId: string): void {
    for (const [tabId, target] of this.pending) if (target.profileId === profileId) this.closed(tabId);
  }

  dispose(): void {
    this.disposed = true;
    for (const tabId of this.pending.keys()) this.cancel(tabId);
    this.locations.clear();
  }
}
