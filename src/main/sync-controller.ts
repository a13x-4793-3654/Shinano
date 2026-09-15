import { randomBytes, randomUUID } from 'node:crypto';
import { MAX_PROFILES, type Panel, type Profile } from '../shared/model.ts';
import {
  HISTORY_RETENTION_MS, LIBRARY_PAGE_SIZE, MAX_BOOKMARKS, MAX_VISITS,
  type BookmarkDraft, type DataMutation, type HistoryMode, type LibraryCommand, type LibraryEntry, type LibraryPage, type LibraryQuery,
} from '../shared/library.ts';
import { bookmarkUrl, historyLocation, pageTitle, sensitiveHistoryUrl } from '../shared/library-validation.ts';
import type {
  ChangePassphraseRequest, CreateVaultRequest, DataIndicator, FolderSelection, JoinVaultRequest, SyncCommand,
  SyncProfile, SyncStatus, UnlockVaultRequest, VaultSetup,
} from '../shared/sync.ts';
import { id, UserError } from '../shared/validation.ts';
import { LibraryStore, type ProfileSettings } from './library-store.ts';
import { TotpStore } from './totp-store.ts';
import {
  createWrapping, seal, unseal, unlockWrapping, validatePassphrase, verifyWrapping, type WrappingEnvelope,
} from './vault-crypto.ts';
import { VaultFolder } from './vault-folder.ts';
import { digest, parseOperation, VaultModel, type OperationInput, type OperationOf, type PortableTotp, type VaultOperation } from './vault-records.ts';

export interface DataHost {
  profiles(): readonly Profile[];
  deletedProfileIds(): readonly string[];
  panel(): Panel;
  applyProfile(profile: Profile): void;
  currentBookmark(): BookmarkDraft;
  open(profileId: string, url: string): void;
  confirm(title: string, message: string, detail: string): Promise<boolean>;
  chooseDirectory(): Promise<string | null>;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  changed(): void;
  notify(message: string): void;
}

interface CollectedVault {
  model: VaultModel;
  operations: VaultOperation[];
  files: { name: string; digest: string; profileId: string; recordId: string; at: number }[];
  wrappings: WrappingEnvelope[];
}

interface PendingSetup {
  id: string;
  folder: VaultFolder;
  vaultId: string;
  key: Buffer;
  wrapping: WrappingEnvelope;
  remember: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof UserError ? error.message : '同期の操作を完了できませんでした。OS の鍵・保存先・暗号化データを確認してください。既存データは保持しています。';
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);
}

function wrappingHeads(wrappings: WrappingEnvelope[]): WrappingEnvelope[] {
  const byId = new Map(wrappings.map((entry) => [entry.wrapperId, entry]));
  const parents = new Set<string>();
  for (const wrapping of wrappings) {
    if (!wrapping.parents.length && wrapping.generation !== 1) throw new UserError('同期金庫の鍵世代の対応が正しくありません。');
    for (const parentId of wrapping.parents) {
      const parent = byId.get(parentId);
      if (!parent) throw new UserError('同期金庫の以前の鍵情報が未取得です。フォルダーの取得を待って再試行してください。');
      if (parent.generation >= wrapping.generation) throw new UserError('同期金庫の鍵の世代が循環しています。');
      parents.add(parentId);
    }
  }
  const heads = wrappings.filter((entry) => !parents.has(entry.wrapperId));
  if (!heads.length || heads.length > 8) throw new UserError('同期金庫の鍵の競合数が上限を超えています。');
  return heads.sort((a, b) => b.generation - a.generation || (a.wrapperId < b.wrapperId ? -1 : 1));
}

export class DataController {
  private host: DataHost | null = null;
  private readonly models = new Map<string, VaultModel>();
  private remote = new VaultModel();
  private rootKey: Buffer | null = null;
  private folder: VaultFolder | null = null;
  private wrappings: WrappingEnvelope[] = [];
  private selection: { id: string; folder: VaultFolder } | null = null;
  private setup: PendingSetup | null = null;
  private generation = 0;
  private lifetime = new AbortController();
  private revision = 0;
  private phase: SyncStatus['phase'] = 'unconfigured';
  private message: string | null = null;
  private localError: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private credentialGeneration = 0;
  readonly local: LibraryStore;
  private readonly totp: TotpStore;
  private readonly forbiddenRoots: readonly string[];
  private readonly now: () => number;

  constructor(
    local: LibraryStore,
    totp: TotpStore,
    forbiddenRoots: readonly string[],
    now: () => number = Date.now,
  ) {
    this.local = local;
    this.totp = totp;
    this.forbiddenRoots = forbiddenRoots;
    this.now = now;
  }

  async initialize(): Promise<void> {
    try {
      await this.local.initialize();
      await this.local.prune(this.now());
      this.rebuild();
      this.phase = this.local.settings.association ? 'locked' : 'unconfigured';
    } catch (error) {
      this.localError = errorMessage(error);
    }
  }

  attach(host: DataHost): void {
    this.host = host;
    this.schedule();
  }

  indicator(): DataIndicator {
    return { revision: this.revision, error: this.localError, syncPhase: this.phase, generation: this.generation + this.credentialGeneration };
  }

  private ui(): DataHost {
    if (!this.host || this.disposed) throw new UserError('Shinano のデータ操作を終了しています。');
    return this.host;
  }

  private checked(authorized: () => boolean, kind: 'library' | 'sync'): void {
    const panel = this.ui().panel();
    if (!authorized() || (kind === 'sync' ? panel !== 'sync' : panel !== 'bookmarks' && panel !== 'history')) {
      throw new UserError('対象の Shinano メイン操作画面から操作してください。');
    }
    if (this.localError) throw new UserError(this.localError);
  }

  private profile(profileId: string): Profile {
    const profile = this.ui().profiles().find((entry) => entry.id === id(profileId));
    if (!profile || this.local.isSuppressed(profileId)) throw new UserError('この端末のプロファイルが見つかりません。');
    return profile;
  }

  private changed(): void {
    this.revision++;
    this.host?.changed();
  }

  private failure(error: unknown): never {
    this.message = errorMessage(error);
    if (this.rootKey) { this.phase = 'error'; this.invalidate(); }
    else if (!this.localError) this.phase = this.local.settings.association ? 'locked' : 'unconfigured';
    this.changed();
    throw new UserError(this.message);
  }

  private rebuild(): void {
    this.models.clear();
    const now = this.now();
    for (const entry of this.local.all()) {
      let model = this.models.get(entry.space);
      if (!model) { model = new VaultModel(); this.models.set(entry.space, model); }
      model.advanceFloor(this.local.settings.retentionFloor);
      model.add(entry.operation, now);
    }
  }

  private async pruneLocal(): Promise<void> {
    const fences = new Map<string, number>();
    for (const [space, model] of this.models) for (const profileId of model.profiles()) {
      fences.set(`${space}:${profileId}`, model.sharedFloor(profileId));
    }
    await this.local.prune(this.now(), fences);
  }

  private model(space: string): VaultModel {
    let value = this.models.get(space);
    if (!value) { value = new VaultModel(); value.advanceFloor(this.local.settings.retentionFloor); this.models.set(space, value); }
    value.advanceFloor(this.local.settings.retentionFloor);
    return value;
  }

  private lease(): { key: Buffer; vaultId: string; check: () => void } {
    const association = this.local.settings.association;
    if (!association || !this.rootKey || !this.folder) throw new UserError('同期金庫を解除してください。');
    const generation = this.generation;
    const signal = this.lifetime.signal;
    return {
      key: Buffer.from(this.rootKey), vaultId: association.vaultId,
      check: () => {
        if (this.disposed || signal.aborted || generation !== this.generation || !this.rootKey) throw new UserError('同期金庫の状態が変わったため操作を中止しました。');
      },
    };
  }

  private invalidate(): void {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.generation++;
  }

  lock(): void {
    this.invalidate();
    this.setup?.key.fill(0);
    this.setup = null;
    this.rootKey?.fill(0);
    this.rootKey = null;
    this.remote = new VaultModel();
    this.wrappings = [];
    if (!this.localError) this.phase = this.local.settings.association ? 'locked' : 'unconfigured';
    this.message = null;
    this.changed();
  }

  private schedule(): void {
    if (this.disposed || this.timer) return;
    let delay = 30_000;
    if (!this.localError) {
      for (const entry of this.local.all()) if (entry.operation.kind === 'visit') {
        delay = Math.min(delay, Math.max(1, entry.operation.at + HISTORY_RETENTION_MS - this.now()));
      }
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed || !this.host) return;
      void Promise.resolve().then(() => this.ui().enqueue(async () => {
        if (this.localError) return;
        const before = this.local.all().length;
        await this.pruneLocal();
        if (before !== this.local.all().length) { this.rebuild(); this.changed(); }
        if (this.rootKey) await this.refresh();
      })).catch((error: unknown) => {
        if (!this.disposed) this.host?.notify(errorMessage(error));
      }).finally(() => this.schedule());
    }, delay);
    this.timer.unref();
  }

  private async add(space: string, input: OperationInput, at = this.now(), preflighted = false): Promise<VaultOperation> {
    const model = this.model(space);
    const operation = await this.local.operation(input, at);
    model.validate(operation, this.now());
    if (!preflighted && (operation.kind === 'visit' || operation.kind === 'bookmark')) {
      let count = 0;
      for (const profileId of model.profiles()) count += model.library(profileId, operation.kind === 'visit' ? 'history' : 'bookmarks', this.now()).length;
      const exists = operation.kind === 'bookmark' && model.heads('bookmark', operation.profileId, operation.recordId).length > 0;
      if (!exists && count >= (operation.kind === 'visit' ? MAX_VISITS : MAX_BOOKMARKS)) throw new UserError('保存件数の上限です。既存データを残し、新しい記録は保存していません。');
    }
    await this.local.commit(space, operation);
    model.add(operation, this.now(), true);
    this.changed();
    return operation;
  }

  private async ensureProfile(space: string, profile: Profile): Promise<void> {
    if (this.model(space).heads('profile', profile.id).length) return;
    await this.add(space, { kind: 'profile', profileId: profile.id, recordId: profile.id, parents: [], value: profile });
  }

  private libraryEntries(profileId: string, kind: 'bookmarks' | 'history'): LibraryEntry[] {
    const settings = this.local.profile(profileId);
    const space = kind === 'bookmarks' ? settings.bookmarkSpace : settings.historySpace;
    return this.model(space).library(profileId, kind, this.now()).filter((entry) =>
      (kind !== 'history' || entry.at > settings.clearThrough)
      && !this.local.hiddenRecord(profileId, space, kind, entry.id));
  }

  async query(request: LibraryQuery, authorized: () => boolean): Promise<LibraryPage> {
    this.checked(authorized, 'library');
    const before = this.local.all().length;
    await this.pruneLocal();
    this.checked(authorized, 'library');
    if (before !== this.local.all().length) { this.rebuild(); this.changed(); }
    if (request.profileId) this.profile(request.profileId);
    if (request.cursor && request.cursor.revision !== this.revision) throw new UserError('一覧が更新されました。先頭から検索し直してください。');
    const search = request.query.normalize('NFKC').toLocaleLowerCase('ja-JP');
    const entries = this.ui().profiles().filter((profile) => !request.profileId || profile.id === request.profileId)
      .flatMap((profile) => this.libraryEntries(profile.id, request.kind))
      .filter((entry) => !search || `${entry.title}\n${entry.url}`.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(search))
      .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const offset = request.cursor?.offset ?? 0;
    if (offset > entries.length) throw new UserError('一覧の位置が変わりました。検索し直してください。');
    return {
      revision: this.revision, entries: entries.slice(offset, offset + LIBRARY_PAGE_SIZE), total: entries.length,
      next: offset + LIBRARY_PAGE_SIZE < entries.length ? { revision: this.revision, offset: offset + LIBRARY_PAGE_SIZE } : null,
      historyMode: request.profileId ? this.local.profile(request.profileId).mode : null,
    };
  }

  currentBookmark(authorized: () => boolean): BookmarkDraft {
    this.checked(authorized, 'library');
    const value = this.ui().currentBookmark();
    this.profile(value.profileId);
    return { profileId: value.profileId, title: pageTitle(value.title, new URL(bookmarkUrl(value.url)).hostname), url: bookmarkUrl(value.url) };
  }

  async libraryCommand(command: LibraryCommand, authorized: () => boolean): Promise<DataMutation> {
    this.checked(authorized, 'library');
    const profile = this.profile(command.profileId);
    const settings = this.local.profile(profile.id);
    if (command.type === 'history:mode') {
      await this.local.updateProfile({ ...settings, mode: command.mode });
      this.changed();
      return { outcome: 'updated' };
    }
    if (command.type === 'history:clear') {
      const shared = command.scope === 'vault';
      const space = settings.historySpace;
      if (shared) this.requireSpace(space);
      const accepted = await this.ui().confirm('履歴の削除', `「${profile.name}」の履歴を${shared ? '同期金庫の全 PC から' : 'この端末だけから'}削除しますか？`,
        '確認した時点以前の履歴が対象です。遅れて到着した同じ範囲の履歴も表示しません。Web サイトのデータやブックマークは削除しません。クラウドのバージョン履歴の完全消去は保証しません。');
      if (!accepted) return { outcome: 'cancelled' };
      this.checked(authorized, 'library');
      this.profile(profile.id);
      const through = this.now();
      if (shared) await this.add(space, { kind: 'history-clear', profileId: profile.id, recordId: profile.id, parents: [], value: { through } }, through);
      else await this.local.updateProfile({ ...settings, clearThrough: Math.max(settings.clearThrough, through) });
      this.changed();
      return { outcome: 'removed' };
    }
    if (command.type === 'bookmark:save') {
      const model = this.model(settings.bookmarkSpace);
      const heads = command.recordId ? model.heads('bookmark', profile.id, command.recordId) : [];
      if (command.recordId && (!heads.length || !sameIds(heads.map((entry) => entry.id), command.parents))) throw new UserError('ブックマークの編集元が変わりました。一覧で内容を確認し直してください。');
      if (!command.recordId && command.parents.length) throw new UserError('新しいブックマークに編集元は指定できません。');
      const accepted = await this.ui().confirm('ブックマークを保存', `「${profile.name}」に URL 全体を保存しますか？`,
        `${sensitiveHistoryUrl(command.url) ? '認証に関連する可能性がある URL です。\n' : ''}パス・クエリ・フラグメントに秘密情報があると一緒に保存されます。同期対象の場合は暗号化して他の PC へ共有します。編集欄の URL を確認してください。`);
      if (!accepted) return { outcome: 'cancelled' };
      this.checked(authorized, 'library');
      this.profile(profile.id);
      await this.ensureProfile(settings.bookmarkSpace, profile);
      await this.add(settings.bookmarkSpace, {
        kind: 'bookmark', profileId: profile.id, recordId: command.recordId ?? randomUUID(), parents: command.parents,
        value: { title: command.title, url: command.url, createdAt: heads[0]?.value.createdAt ?? this.now() },
      });
      return { outcome: 'saved' };
    }
    const entry = this.libraryEntries(profile.id, command.kind).find((item) => item.id === command.recordId);
    if (!entry) throw new UserError('項目が削除または更新されています。一覧を確認してください。');
    if (command.type === 'entry:open') {
      if (entry.revision !== command.revision || entry.versions.length > 1) throw new UserError('項目が更新・競合しています。内容を確認してから開いてください。');
      this.ui().open(profile.id, bookmarkUrl(entry.url));
      return { outcome: 'opened' };
    }
    const shared = command.scope === 'vault';
    const space = command.kind === 'bookmarks' ? settings.bookmarkSpace : settings.historySpace;
    if (shared) this.requireSpace(space);
    if (!await this.ui().confirm('項目の削除', `この項目を${shared ? '同期金庫からも' : 'この端末だけから'}削除しますか？`,
      shared ? '他の PC にも削除を伝えます。元の記録 ID は復活させません。クラウドの古いバージョンの消去は保証しません。' : '同期金庫や他の PC の記録は残ります。この端末では遅れた同期で復活させません。')) return { outcome: 'cancelled' };
    this.checked(authorized, 'library');
    this.profile(profile.id);
    if (shared) await this.add(space, {
      kind: 'delete', profileId: profile.id, recordId: entry.id, parents: [], value: { target: command.kind === 'bookmarks' ? 'bookmark' : 'visit' },
    });
    else await this.local.hide(profile.id, space, command.kind, entry.id, entry.at);
    this.changed();
    return { outcome: 'removed' };
  }

  mode(profileId: string): HistoryMode {
    if (this.localError || this.local.isSuppressed(profileId)) return 'off';
    return this.local.profile(profileId).mode;
  }

  async recordVisit(profileId: string, rawUrl: string, title: string, at: number, mode: Exclude<HistoryMode, 'off'>): Promise<void> {
    if (this.mode(profileId) !== mode) return;
    const profile = this.profile(profileId);
    const url = historyLocation(rawUrl, mode);
    if (!url) return;
    const settings = this.local.profile(profileId);
    if (at <= Math.max(this.local.settings.retentionFloor, settings.clearThrough, this.now() - HISTORY_RETENTION_MS)) return;
    await this.ensureProfile(settings.historySpace, profile);
    await this.add(settings.historySpace, {
      kind: 'visit', profileId, recordId: randomUUID(), parents: [],
      value: { visitedAt: at, url, title: mode === 'origins' ? new URL(url).hostname : pageTitle(title, new URL(url).hostname), mode },
    }, at);
  }

  async profileUpdated(profile: Profile): Promise<void> {
    if (this.localError) throw new UserError(this.localError);
    const settings = this.local.profile(profile.id);
    if (!settings.linkedVaultId) return;
    const space = settings.linkedVaultId;
    const heads = this.model(space).heads('profile', profile.id);
    if (heads.length > 1) throw new UserError('共有プロファイル名が競合しています。同期画面で先に解決してください。');
    await this.add(space, { kind: 'profile', profileId: profile.id, recordId: profile.id, parents: heads.map((entry) => entry.id), value: profile });
  }

  suppressProfile(profileId: string): void { this.local.suppressProfile(profileId); this.invalidate(); }
  removeLocalProfile(profileId: string): void { this.local.removeProfile(profileId); if (!this.localError) this.rebuild(); this.changed(); }

  checkTotpReplacement(profileId: string): void {
    if (this.localError) throw new UserError(this.localError);
    if (this.local.intent(profileId)) throw new UserError('未完了の TOTP 移行を完了または取り消してから、ローカル登録を置き換えてください。');
  }

  async localTotpChanged(profileId: string): Promise<void> {
    this.local.blockTotpSync(profileId);
    if (!this.localError) this.rebuild();
    this.invalidate();
    this.changed();
  }

  checkTotp(profileId: string): void {
    if (this.localError) {
      if (this.local.error) throw new UserError(this.localError);
      return;
    }
    const settings = this.local.profile(profileId);
    if (this.local.intent(profileId)) throw new UserError('TOTP の移行が未完了です。同期画面で移行を完了するか、取り消してください。');
    if (!settings.totpBinding) return;
    if (!this.rootKey || this.phase !== 'ready') throw new UserError('共有 TOTP を使用するには同期金庫を解除し、同期エラーを解消してください。');
    const heads = this.remote.heads('totp', profileId);
    if (heads.length !== 1 || heads[0]!.value.registrationId !== settings.totpBinding.registrationId) throw new UserError('共有 TOTP が削除・変更・競合しています。同期画面で確認してください。');
  }

  private requireSpace(space: string): void {
    if (!this.rootKey || this.local.settings.association?.vaultId !== space || this.phase !== 'ready') throw new UserError('この項目の同期金庫を解除し、同期エラーを解消してから操作してください。');
  }

  private outbound(entry: { space: string; operation: VaultOperation; published: boolean }): boolean {
    const association = this.local.settings.association;
    if (!association || entry.space !== association.vaultId || entry.published || this.local.isSuppressed(entry.operation.profileId)) return false;
    const operation = entry.operation;
    const settings = this.local.profile(operation.profileId);
    if (operation.kind === 'delete' || operation.kind === 'history-clear' || operation.kind === 'history-retention') return true;
    if (settings.linkedVaultId !== association.vaultId) return false;
    if (operation.kind === 'profile') return true;
    if (operation.kind === 'bookmark') return settings.bookmarks;
    if (operation.kind === 'visit') return settings.history;
    return operation.kind === 'totp' && settings.totpBinding?.vaultId === association.vaultId && settings.totpBinding.registrationId === operation.value.registrationId;
  }

  status(authorized: () => boolean): SyncStatus {
    this.checked(authorized, 'sync');
    const association = this.local.settings.association;
    const ids = new Set([...this.ui().profiles().map((profile) => profile.id), ...this.remote.profiles()]);
    const profiles: SyncProfile[] = [...ids].sort().map((profileId) => {
      const installed = this.ui().profiles().find((profile) => profile.id === profileId);
      const settings = this.local.profile(profileId);
      const profileHeads = this.remote.heads('profile', profileId);
      const totpHeads = this.remote.heads('totp', profileId);
      const profile = installed ?? profileHeads[0]?.value;
      const registration = installed ? this.totp.registration(profileId, true) : null;
      return {
        id: profileId, name: profile?.name ?? '削除済みプロファイル', color: profile?.color ?? 'slate',
        installed: Boolean(installed), suppressed: this.local.isSuppressed(profileId), linked: settings.linkedVaultId === association?.vaultId,
        bookmarks: settings.bookmarks, history: settings.history, localRegistrationId: registration?.status === 'registered' ? registration.registrationId : null,
        sharedRegistrationId: totpHeads.length === 1 ? totpHeads[0]!.value.registrationId : null,
        totpState: this.local.intent(profileId) ? 'pending' : registration?.status === 'unreadable' ? 'unreadable' : totpHeads.length > 1 ? 'conflict'
          : settings.totpBinding ? 'linked' : totpHeads.length ? 'available' : 'none',
        versions: profileHeads.map((entry) => ({ revision: entry.id, name: entry.value.name, color: entry.value.color })),
        totpVersions: totpHeads.map((entry) => ({ revision: entry.id, registrationId: entry.value.registrationId, issuer: entry.value.issuer, account: entry.value.account })),
      };
    });
    return {
      phase: this.phase, vaultId: association?.vaultId ?? null, folder: association?.root ?? null,
      hasDeviceKey: this.local.hasDeviceKey(), generation: this.generation + this.credentialGeneration,
      pending: this.local.all().filter((entry) => this.outbound(entry)).length,
      lastReadAt: this.local.settings.lastReadAt, lastWriteAt: this.local.settings.lastWriteAt, message: this.message,
      wrappingConflict: this.wrappings.length ? wrappingHeads(this.wrappings).length > 1 : false, profiles,
    };
  }

  async chooseFolder(authorized: () => boolean): Promise<FolderSelection | null> {
    this.checked(authorized, 'sync');
    if (this.local.settings.association) throw new UserError('別の金庫を選ぶ前に、現在の同期接続を明示的に解除してください。');
    const path = await this.ui().chooseDirectory();
    this.checked(authorized, 'sync');
    if (!path) return null;
    const folder = await VaultFolder.select(path, this.forbiddenRoots);
    const vaultIds = await folder.listVaultIds();
    this.checked(authorized, 'sync');
    const selectionId = randomUUID();
    this.selection = { id: selectionId, folder };
    return { selectionId, displayPath: folder.root, vaultIds };
  }

  async create(request: CreateVaultRequest, authorized: () => boolean): Promise<VaultSetup> {
    this.checked(authorized, 'sync');
    if (!this.selection || this.selection.id !== request.selectionId || this.local.settings.association || this.setup) throw new UserError('同期フォルダーを選び直してください。');
    validatePassphrase(request.passphrase);
    if (request.passphrase !== request.confirmation) throw new UserError('確認用のパスフレーズが一致しません。');
    const folder = this.selection.folder;
    const generation = this.generation;
    const key = randomBytes(32);
    const vaultId = randomUUID();
    try {
      const result = await createWrapping(vaultId, key, request.passphrase);
      this.checked(authorized, 'sync');
      if (generation !== this.generation) throw new UserError('金庫の作成を中止しました。もう一度操作してください。');
      if (!result.recoveryKey) throw new UserError('復旧キーを生成できませんでした。');
      const setupId = randomUUID();
      this.setup = { id: setupId, folder, vaultId, key, wrapping: result.wrapping, remember: request.remember };
      return { setupId, recoveryKey: result.recoveryKey };
    } catch (error) { key.fill(0); throw error; }
    finally { request.passphrase = ''; request.confirmation = ''; }
  }

  private async collect(folder: VaultFolder, vaultId: string, key: Buffer, check: () => void): Promise<CollectedVault> {
    const wrappings = await folder.readWrappings(vaultId);
    check();
    for (const wrapping of wrappings) verifyWrapping(wrapping, key);
    const heads = wrappingHeads(wrappings);
    const association = this.local.settings.association;
    if (association?.vaultId === vaultId && (Math.max(...heads.map((entry) => entry.generation)) < association.wrappingGeneration
      || association.wrappingIds.some((known) => !wrappings.some((entry) => entry.wrapperId === known)))) {
      throw new UserError('以前確認した鍵情報がフォルダーにありません。巻き戻しまたは未取得の可能性があるため、同期を保留しました。');
    }
    const model = new VaultModel();
    model.advanceFloor(this.local.settings.retentionFloor);
    for (const entry of this.local.all()) if (entry.space === vaultId) model.add(entry.operation, this.now());
    const operations = new Map<string, VaultOperation>();
    const files: CollectedVault['files'] = [];
    const envelopeHashes = new Map<string, string>();
    for await (const file of folder.operations(vaultId)) {
      check();
      const previous = envelopeHashes.get(file.envelope.envelopeId);
      if (previous && previous !== file.digest) throw new UserError('同じ暗号化ファイル ID の内容が競合しています。');
      envelopeHashes.set(file.envelope.envelopeId, file.digest);
      const plaintext = unseal('operation', vaultId, key, file.envelope);
      let operation: VaultOperation;
      try { operation = parseOperation(JSON.parse(plaintext.toString('utf8'))); } finally { plaintext.fill(0); }
      model.add(operation, this.now());
      const accepted = model.get(operation.id);
      if (accepted) operations.set(operation.id, accepted);
      if (operation.kind === 'visit') files.push({ name: file.name, digest: file.digest, profileId: operation.profileId, recordId: operation.recordId, at: operation.at });
    }
    check();
    model.assertLiveLimits(this.now());
    if (model.hasPending()) throw new UserError('同期の編集元またはプロファイル情報が未取得です。フォルダーの取得を待って再試行してください。');
    return { model, operations: [...operations.values()], files, wrappings };
  }

  private async openWithInput(folder: VaultFolder, vaultId: string, method: 'passphrase' | 'recovery', input: string, authorized: () => boolean): Promise<Buffer> {
    const candidates = wrappingHeads(await folder.readWrappings(vaultId));
    this.checked(authorized, 'sync');
    for (const candidate of candidates) {
      let key: Buffer;
      try { key = await unlockWrapping(candidate, method, input); }
      catch (error) {
        if (!(error instanceof UserError)) throw error;
        continue;
      }
      try {
        this.checked(authorized, 'sync');
        return key;
      } catch (error) { key.fill(0); throw error; }
    }
    throw new UserError('パスフレーズ・復旧キー、または同期金庫の鍵情報を確認してください。既存データは変更していません。');
  }

  async join(request: JoinVaultRequest, authorized: () => boolean): Promise<SyncStatus> {
    this.checked(authorized, 'sync');
    if (!this.selection || this.selection.id !== request.selectionId || this.local.settings.association || this.setup) throw new UserError('同期フォルダーを選び直してください。');
    const folder = this.selection.folder;
    const generation = this.generation;
    const active = () => {
      if (generation !== this.generation) throw new UserError('解除中に金庫の状態が変わったため接続を中止しました。');
      return authorized();
    };
    let key: Buffer | null = null;
    try {
      key = await this.openWithInput(folder, request.vaultId, request.method, request.input, active);
      const result = await this.collect(folder, request.vaultId, key, () => this.checked(active, 'sync'));
      this.checked(active, 'sync');
      if (!await this.ui().confirm('同期金庫への接続', 'この暗号化金庫に接続しますか？', '接続だけでは既存の TOTP を送信しません。次の画面でプロファイルと共有する項目、受け取る TOTP を個別に確認してください。')) throw new UserError('同期金庫への接続をキャンセルしました。');
      this.checked(active, 'sync');
      await this.local.updateSettings({ association: {
        vaultId: request.vaultId, root: folder.root, wrappingGeneration: Math.max(...result.wrappings.map((entry) => entry.generation)),
        wrappingIds: result.wrappings.map((entry) => entry.wrapperId).sort(),
      }, lastReadAt: this.now(), lastWriteAt: null });
      this.checked(active, 'sync');
      if (request.remember) await this.local.remember(request.vaultId, key);
      this.checked(active, 'sync');
      this.invalidate();
      this.folder = folder;
      this.rootKey = key;
      key = null;
      this.remote = result.model;
      this.wrappings = result.wrappings;
      this.phase = 'ready';
      this.selection = null;
      this.message = '金庫を解除しました。プロファイルと TOTP の取り込み・共有は下で個別に確認してください。';
      this.changed();
      return this.status(authorized);
    } catch (error) { return this.failure(error); }
    finally { key?.fill(0); request.input = ''; }
  }

  async unlock(request: UnlockVaultRequest, authorized: () => boolean): Promise<SyncStatus> {
    this.checked(authorized, 'sync');
    const association = this.local.settings.association;
    if (!association) throw new UserError('先に同期金庫を作成または選択してください。');
    if (this.rootKey) throw new UserError('同期金庫は解除済みです。再読み込みまたはロックを選択してください。');
    const generation = this.generation;
    const active = () => {
      if (generation !== this.generation) throw new UserError('解除中に金庫がロックされたため操作を中止しました。');
      return authorized();
    };
    let key: Buffer | null = null;
    try {
      const folder = await VaultFolder.select(association.root, this.forbiddenRoots);
      key = request.method === 'device' ? await this.local.remembered(association.vaultId)
        : await this.openWithInput(folder, association.vaultId, request.method, request.input, active);
      const result = await this.collect(folder, association.vaultId, key, () => this.checked(active, 'sync'));
      this.checked(active, 'sync');
      this.invalidate();
      this.rootKey = key;
      key = null;
      this.folder = folder;
      this.remote = result.model;
      this.wrappings = result.wrappings;
      this.phase = 'ready';
      await this.refresh(authorized);
      return this.status(authorized);
    } catch (error) { return this.failure(error); }
    finally { key?.fill(0); request.input = ''; }
  }

  async changePassphrase(request: ChangePassphraseRequest, authorized: () => boolean): Promise<DataMutation> {
    this.checked(authorized, 'sync');
    validatePassphrase(request.passphrase);
    if (request.passphrase !== request.confirmation) throw new UserError('確認用のパスフレーズが一致しません。');
    if (!await this.ui().confirm('パスフレーズの変更', '現在の金庫のパスフレーズを変更しますか？',
      '旧パスフレーズとクラウドの古い鍵ファイル、または鍵を持つオフライン端末からの復号は失効しません。端末の強制失効や完全なデータ再暗号化ではありません。復旧キーは引き続き保管してください。')) return { outcome: 'cancelled' };
    this.checked(authorized, 'sync');
    const lease = this.lease();
    try {
      const collected = await this.collect(this.folder!, lease.vaultId, lease.key, lease.check);
      const heads = wrappingHeads(collected.wrappings);
      const generation = Math.max(...heads.map((entry) => entry.generation)) + 1;
      const result = await createWrapping(lease.vaultId, lease.key, request.passphrase, {
        generation, parents: heads.map((entry) => entry.wrapperId).sort(), recovery: heads[0]!.recovery,
      });
      lease.check();
      this.checked(authorized, 'sync');
      await this.folder!.publishWrapping(lease.vaultId, result.wrapping);
      lease.check();
      await this.local.updateSettings({ association: {
        vaultId: lease.vaultId, root: this.folder!.root, wrappingGeneration: generation,
        wrappingIds: [...collected.wrappings.map((entry) => entry.wrapperId), result.wrapping.wrapperId].sort(),
      }, lastWriteAt: this.now() });
      this.wrappings = [...collected.wrappings, result.wrapping];
      this.invalidate();
      this.message = '新しい鍵情報を選択フォルダーへ保存しました。クラウドや他の PC への到達は確認していません。';
      this.changed();
      return { outcome: 'updated' };
    } catch (error) { return this.failure(error); }
    finally { lease.key.fill(0); request.passphrase = ''; request.confirmation = ''; }
  }

  async refresh(authorized?: () => boolean): Promise<void> {
    if (authorized) this.checked(authorized, 'sync');
    const lease = this.lease();
    const oldCredentials = this.credentialSnapshot(this.remote);
    this.phase = 'busy';
    this.changed();
    try {
      const check = () => { lease.check(); if (authorized) this.checked(authorized, 'sync'); };
      const before = this.local.all().length;
      await this.pruneLocal();
      if (before !== this.local.all().length) this.rebuild();
      check();
      const collected = await this.collect(this.folder!, lease.vaultId, lease.key, check);
      const expiredProfiles = new Set(collected.files.filter((file) => file.at <= collected.model.cutoff(file.profileId, this.now())).map((file) => file.profileId));
      for (const profileId of expiredProfiles) {
        check();
        if (this.local.isSuppressed(profileId) || this.local.profile(profileId).linkedVaultId !== lease.vaultId) continue;
        const through = Math.max(0, this.now() - HISTORY_RETENTION_MS);
        if (collected.model.sharedFloor(profileId) >= through) continue;
        const operation = await this.add(lease.vaultId, {
          kind: 'history-retention', profileId, recordId: profileId, parents: [], value: { through },
        });
        collected.model.add(operation, this.now());
      }
      const oldGeneration = this.local.settings.association!.wrappingGeneration;
      const newGeneration = Math.max(...collected.wrappings.map((entry) => entry.generation));
      await this.local.updateSettings({ association: {
        vaultId: lease.vaultId, root: this.folder!.root, wrappingGeneration: newGeneration,
        wrappingIds: collected.wrappings.map((entry) => entry.wrapperId).sort(),
      }, lastReadAt: this.now() });
      check();
      const seen = new Set(collected.operations.map((entry) => entry.id));
      for (const entry of this.local.all().filter((item) => this.outbound(item))) {
        check();
        if (entry.operation.kind === 'visit' && entry.operation.at <= collected.model.cutoff(entry.operation.profileId, this.now())) continue;
        if (!seen.has(entry.operation.id)) {
          const plaintext = Buffer.from(JSON.stringify(entry.operation));
          try { await this.folder!.publishOperation(lease.vaultId, seal('operation', lease.vaultId, lease.key, plaintext)); }
          finally { plaintext.fill(0); }
          await this.local.updateSettings({ lastWriteAt: this.now() });
        }
        check();
        await this.local.commit(lease.vaultId, entry.operation, true);
      }
      this.remote = collected.model;
      if (oldCredentials !== this.credentialSnapshot(this.remote)) this.invalidateCredentialDisplay();
      this.wrappings = collected.wrappings;
      await this.materialize(collected, check);
      check();
      await this.pruneLocal();
      const expired = new Map(collected.files.filter((file) => file.at <= this.remote.cutoff(file.profileId, this.now())).map((file) => [file.name, file.digest]));
      if (expired.size) for await (const file of this.folder!.operations(lease.vaultId)) {
        check();
        const expected = expired.get(file.name);
        if (!expected) continue;
        if (file.digest !== expected) throw new UserError('期限切れの暗号文が途中で変更されました。自動削除を保留しました。');
        await this.folder!.removeOperation(lease.vaultId, file);
      }
      this.rebuild();
      if (oldGeneration !== newGeneration) this.invalidate();
      this.phase = 'ready';
      this.message = '選択フォルダーの読み書きを確認しました。クラウドや他の PC への到達・バックアップ完了は確認していません。';
      this.changed();
    } catch (error) { this.failure(error); }
    finally { lease.key.fill(0); }
  }

  // Profile/credential materialization is intentionally separate from parsing the shared folder.
  private async materialize(collected: CollectedVault, check: () => void): Promise<void> {
    const space = this.local.settings.association!.vaultId;
    for (const operation of collected.operations) {
      check();
      if (this.local.isSuppressed(operation.profileId)) continue;
      const settings = this.local.profile(operation.profileId);
      if (settings.linkedVaultId !== space) continue;
      if (operation.kind === 'bookmark' && !settings.bookmarks) continue;
      if (operation.kind === 'visit' && !settings.history) continue;
      if (operation.kind === 'totp' && !settings.totpBinding) continue;
      await this.local.commit(space, operation, true);
    }
    this.rebuild();
    for (const profile of this.ui().profiles()) {
      check();
      const settings = this.local.profile(profile.id);
      if (settings.linkedVaultId !== space) continue;
      const intent = this.local.intent(profile.id);
      if (intent?.cancelled) {
        await this.cancelTotpImport(profile.id);
        continue;
      }
      if (collected.model.isDeleted(profile.id, 'profile', profile.id)) {
        if (intent) throw new UserError('共有プロファイルは削除されています。未完了の TOTP 移行を自動実行せず保持しました。同期画面で取り消して保存前の登録に戻してください。');
        if (settings.totpBinding) {
          const local = this.totp.registration(profile.id, true);
          if (local.status === 'registered' && local.registrationId === settings.totpBinding.registrationId) this.totp.remove(profile.id);
          await this.local.removeTotpEntries(profile.id, space);
          await this.local.clearIntent(profile.id);
        }
        const localSpace = randomUUID();
        await this.local.updateProfile({
          ...settings, linkedVaultId: null, bookmarks: false, history: false, totpBinding: null,
          bookmarkSpace: settings.bookmarkSpace === space ? localSpace : settings.bookmarkSpace,
          historySpace: settings.historySpace === space ? localSpace : settings.historySpace,
        });
        this.invalidateCredentialDisplay();
        continue;
      }
      const names = collected.model.heads('profile', profile.id);
      if (names.length === 1 && (profile.name !== names[0]!.value.name || profile.color !== names[0]!.value.color)) this.ui().applyProfile(names[0]!.value);
      if (intent && intent.vaultId === space) {
        const heads = collected.model.heads('totp', profile.id);
        if (heads.length !== 1 || digest(heads[0]!.value) !== digest(intent.next)) {
          throw new UserError('TOTP 移行中に共有登録が削除・変更・競合しました。古い鍵を自動で取り込まず、同期画面で移行を取り消せるよう保存前の暗号文を保持しています。');
        }
        await this.applyTotp(profile.id, intent.next, intent.expectedRegistrationId, check);
        continue;
      }
      if (!settings.totpBinding || settings.totpOverride) continue;
      const local = this.totp.registration(profile.id, true);
      if (local.status === 'unreadable') throw new UserError(local.error);
      if (local.status === 'registered' && local.registrationId !== settings.totpBinding.registrationId) {
        throw new UserError('ローカル TOTP が共有登録と異なります。自動で上書きせず保留しました。');
      }
      if (local.status === 'registered') this.totp.finishImport(profile.id, local.registrationId);
      const heads = collected.model.heads('totp', profile.id);
      if (!heads.length && collected.model.isDeleted(profile.id, 'totp', settings.totpBinding.registrationId)) {
        if (local.status === 'registered') this.totp.remove(profile.id);
        await this.local.removeTotpEntries(profile.id, space, settings.totpBinding.registrationId);
        await this.local.updateProfile({ ...settings, totpBinding: null });
        this.invalidateCredentialDisplay();
      } else if (heads.length === 1 && heads[0]!.value.registrationId !== settings.totpBinding.registrationId) {
        await this.applyTotp(profile.id, heads[0]!.value, local.status === 'registered' ? local.registrationId : null, check);
      }
    }
  }

  private invalidateCredentialDisplay(): void {
    this.credentialGeneration++;
    this.changed();
  }

  private credentialSnapshot(model: VaultModel): string {
    return digest(model.profiles().map((profileId) => [profileId, model.heads('totp', profileId).map((entry) => [entry.id, entry.value.registrationId])]));
  }

  private async applyTotp(profileId: string, value: PortableTotp, expected: string | null, check: () => void): Promise<void> {
    const vaultId = this.local.settings.association!.vaultId;
    await this.local.saveIntent(profileId, { version: 1, profileId, vaultId, cancelled: false, expectedRegistrationId: expected, next: value });
    check();
    const key = Buffer.from(value.key, 'base64');
    try {
      this.totp.importRegistration(profileId, { registrationId: value.registrationId, key, metadata: {
        algorithm: value.algorithm, digits: value.digits, period: value.period, issuer: value.issuer, account: value.account,
      } }, expected);
    } finally { key.fill(0); }
    check();
    const settings = this.local.profile(profileId);
    await this.local.updateProfile({ ...settings, totpBinding: { vaultId, registrationId: value.registrationId }, totpOverride: false });
    this.local.allowTotpSync(profileId);
    await this.local.clearIntent(profileId);
    this.totp.finishImport(profileId, value.registrationId);
    this.changed();
  }

  async syncCommand(command: SyncCommand, authorized: () => boolean): Promise<DataMutation> {
    if (command.type === 'cancel-setup') {
      if (!authorized()) throw new UserError('Shinano のメイン操作画面から操作してください。');
      this.setup?.key.fill(0); this.setup = null;
      this.invalidate();
      return { outcome: 'cancelled' };
    }
    this.checked(authorized, 'sync');
    if (command.type === 'totp:cancel-import') {
      const profile = this.profile(command.profileId);
      if (!this.local.intent(profile.id)) throw new UserError('取り消す TOTP 移行がありません。');
      if (!await this.ui().confirm('未完了の TOTP 移行を取り消す', `「${profile.name}」を取り込み前の登録に戻しますか？`,
        '保存前の OS 保護付き暗号文を確認して復元します。元の登録がなければ未完了の取り込みだけを削除します。共有金庫やサービス側の MFA は変更せず、この端末での TOTP 自動取り込みを停止します。')) return { outcome: 'cancelled' };
      this.checked(authorized, 'sync');
      await this.local.cancelIntent(profile.id);
      await this.cancelTotpImport(profile.id);
      return { outcome: 'updated' };
    }
    if (command.type === 'lock') { this.lock(); return { outcome: 'updated' }; }
    if (command.type === 'refresh') { await this.refresh(authorized); return { outcome: 'updated' }; }
    if (command.type === 'finish-create') {
      const setup = this.setup;
      if (!setup || setup.id !== command.setupId || !command.recoveryAcknowledged) throw new UserError('復旧キーの保管を確認してください。');
      const generation = this.generation;
      const check = () => {
        this.checked(authorized, 'sync');
        if (this.setup !== setup || this.generation !== generation) {
          throw new UserError('金庫の作成完了前に状態が変わりました。フォルダーに鍵情報がある場合は、作成時のパスフレーズまたは復旧キーで接続してください。');
        }
      };
      try {
        if (!await this.ui().confirm('同期金庫の作成', '選択したフォルダーに暗号化金庫を作成しますか？', '作成だけでは TOTP や閲覧データを送信しません。次の画面で共有するプロファイルと項目を個別に確認してください。')) {
          setup.key.fill(0);
          if (this.setup === setup) this.setup = null;
          this.invalidate();
          this.changed();
          return { outcome: 'cancelled' };
        }
        check();
        await setup.folder.createVault(setup.vaultId, setup.wrapping);
        check();
        await this.local.updateSettings({ association: { vaultId: setup.vaultId, root: setup.folder.root, wrappingGeneration: 1, wrappingIds: [setup.wrapping.wrapperId] }, lastWriteAt: this.now() });
        check();
        if (setup.remember) { await this.local.remember(setup.vaultId, setup.key); check(); }
        this.invalidate();
        this.folder = setup.folder; this.rootKey = setup.key; this.wrappings = [setup.wrapping]; this.setup = null; this.selection = null;
        this.remote = new VaultModel(); this.phase = 'ready';
        this.message = '空の暗号化金庫を選択フォルダーへ保存しました。共有するプロファイルを選択してください。';
        this.changed();
        return { outcome: 'saved' };
      } catch (error) {
        if (this.rootKey === setup.key) this.rootKey = null;
        setup.key.fill(0);
        if (this.setup === setup) this.setup = null;
        return this.failure(error);
      }
    }
    if (command.type === 'forget' || command.type === 'unlink') {
      if (command.type === 'unlink' && this.local.pendingProfiles().length) throw new UserError('未完了の TOTP 移行を完了または取り消してから、同期接続を解除してください。');
      if (!await this.ui().confirm(command.type === 'forget' ? '端末の解除鍵を削除' : '同期接続を解除',
        command.type === 'forget' ? 'この端末の OS 保護付き解除鍵を削除しますか？' : 'この端末と同期金庫の接続を解除しますか？',
        '共有フォルダー、他の PC、Web サイトのログインは変更しません。ローカルの閲覧記録と TOTP は残ります。未送信の変更の自動送信を停止します。旧パスフレーズや他端末の鍵を失効させる機能ではありません。')) return { outcome: 'cancelled' };
      this.checked(authorized, 'sync');
      this.local.forget();
      this.lock();
      if (command.type === 'unlink') {
        for (const profile of this.ui().profiles()) {
          const settings = this.local.profile(profile.id);
          await this.local.updateProfile({ ...settings, linkedVaultId: null, bookmarks: false, history: false, totpBinding: null });
        }
        await this.local.updateSettings({ association: null, lastReadAt: null, lastWriteAt: null });
        this.folder = null; this.phase = 'unconfigured';
      }
      this.changed();
      return { outcome: 'updated' };
    }
    const lease = this.lease();
    try {
      const check = () => { lease.check(); this.checked(authorized, 'sync'); };
      if (command.type === 'profile:restore') {
        if (this.ui().deletedProfileIds().includes(command.profileId)) throw new UserError('削除後の残存ファイル処理が必要です。Shinano を再起動してから復元してください。');
        if (!await this.ui().confirm('プロファイルの復元', 'この端末で非表示にした共有プロファイルを再び使用しますか？', '元のプロファイル UUID を使用します。Web サイトへの再サインインや MFA は通常どおり必要です。TOTP の取り込みは別途確認します。')) return { outcome: 'cancelled' };
        check();
        this.local.restoreProfile(command.profileId);
        this.changed();
        return { outcome: 'updated' };
      }
      if (command.type === 'profile:link') return await this.linkProfile(command.profileId, command.bookmarks, command.history, check);
      if (!('profileId' in command)) throw new UserError('対応していない同期操作です。');
      const profile = (command.type === 'profile:resolve' || command.type === 'profile:delete')
        ? this.ui().profiles().find((entry) => entry.id === command.profileId) ?? this.remote.heads('profile', command.profileId)[0]?.value
        : this.profile(command.profileId);
      if (!profile) throw new UserError('共有プロファイルが見つかりません。');
      const settings = this.local.profile(profile.id);
      if (command.type === 'profile:unlink') {
        if (this.local.intent(profile.id)) throw new UserError('未完了の TOTP 移行を完了または取り消してから、このプロファイルの同期を停止してください。');
        if (!await this.ui().confirm('プロファイルの同期を停止', `「${profile.name}」の同期をこの端末で停止しますか？`, 'ローカル記録と TOTP は残し、他の PC と共有金庫は削除しません。再開時には項目を再確認します。')) return { outcome: 'cancelled' };
        check();
        await this.local.updateProfile({ ...settings, linkedVaultId: null, bookmarks: false, history: false, totpBinding: null });
        this.changed();
        return { outcome: 'updated' };
      }
      if (command.type === 'profile:delete') {
        if (!await this.ui().confirm('共有プロファイルの削除', `「${profile.name}」と関連する共有データを同期金庫から削除しますか？`,
          '共有ブックマーク・履歴・TOTP を他の PC からも削除する記録を送信します。この端末のブラウザーの Cookie・タブやクラウドのアカウントは削除しません。削除した共有 UUID は再利用しません。')) return { outcome: 'cancelled' };
        check();
        await this.add(lease.vaultId, { kind: 'delete', profileId: profile.id, recordId: profile.id, parents: [], value: { target: 'profile' } });
      } else if (command.type === 'profile:resolve') {
        const heads = this.remote.heads('profile', profile.id);
        const selected = heads.find((entry) => entry.id === command.revision);
        if (!selected) throw new UserError('共有プロファイルの候補が更新されています。');
        if (!await this.ui().confirm('共有プロファイル名の競合解決', 'この名前・色を共有プロファイルに採用しますか？', '表示された編集候補を、この新しい確定版で置き換えます。')) return { outcome: 'cancelled' };
        check();
        await this.add(lease.vaultId, { kind: 'profile', profileId: profile.id, recordId: profile.id, parents: heads.map((entry) => entry.id), value: selected.value });
      } else if (command.type === 'totp:share') {
        if (this.local.intent(profile.id)) throw new UserError('未完了の TOTP 移行を完了または取り消してください。');
        if (settings.linkedVaultId !== lease.vaultId) throw new UserError('先に対象のプロファイルを同期金庫へ接続してください。');
        const priorHeads = this.remote.heads('totp', profile.id);
        if (!await this.ui().confirm('TOTP の暗号化共有', `「${profile.name}」の選択した TOTP 登録を共有しますか？`,
          `${priorHeads.some((entry) => entry.value.registrationId !== command.registrationId) ? '既存の共有 TOTP を他の PC でもこの登録に置き換えます。\n' : ''}この登録の秘密鍵をアプリ内で再暗号化し、選択フォルダーへ送ります。OS 保護の暗号文をそのままコピーしません。ブラウザーと認証キーを同じ PC に置くと MFA の独立性が下がります。サービス側の MFA は変更しません。`)) return { outcome: 'cancelled' };
        check();
        const stored = this.totp.load(profile.id, command.registrationId);
        try {
          const heads = this.remote.heads('totp', profile.id);
          if (heads.length > 1) throw new UserError('共有 TOTP が競合しています。先に共有候補を確認・解決してください。');
          await this.add(lease.vaultId, {
            kind: 'totp', profileId: profile.id, recordId: profile.id, parents: heads.map((entry) => entry.id),
            value: { registrationId: stored.registrationId, key: stored.key.toString('base64'), ...stored.metadata },
          });
          await this.local.updateProfile({ ...settings, totpBinding: { vaultId: lease.vaultId, registrationId: stored.registrationId }, totpOverride: false });
          this.local.allowTotpSync(profile.id);
        } finally { stored.key.fill(0); }
      } else if (command.type === 'totp:accept') {
        if (this.local.intent(profile.id)) throw new UserError('未完了の TOTP 移行を完了または取り消してください。');
        if (settings.linkedVaultId !== lease.vaultId) throw new UserError('先に対象のプロファイルを接続してください。');
        const heads = this.remote.heads('totp', profile.id);
        const selected = heads.find((entry) => entry.id === command.revision);
        if (!selected) throw new UserError('共有 TOTP の候補が更新されています。');
        if (!await this.ui().confirm('共有 TOTP の取り込み', `「${profile.name}」へこの TOTP 登録を取り込みますか？`,
          'このプロファイル UUID に結び付け、この PC の OS 鍵で再暗号化します。既存登録と異なる場合は置き換えます。競合候補を選んだ場合はその選択を共有金庫にも記録します。サービス側の MFA は変更しません。')) return { outcome: 'cancelled' };
        check();
        const current = this.totp.registration(profile.id, true);
        if (current.status === 'unreadable') throw new UserError(current.error);
        if ((current.status === 'registered' ? current.registrationId : null) !== command.expectedRegistrationId) throw new UserError('ローカル TOTP が変更されています。取り込みを確認し直してください。');
        const accepted = heads.length > 1 ? await this.add(lease.vaultId, {
          kind: 'totp', profileId: profile.id, recordId: profile.id, parents: heads.map((entry) => entry.id), value: selected.value,
        }) : selected;
        await this.local.commit(lease.vaultId, accepted, heads.length === 1);
        await this.applyTotp(profile.id, selected.value, command.expectedRegistrationId, check);
      } else if (command.type === 'totp:delete') {
        if (!await this.ui().confirm('共有 TOTP 登録の削除', `「${profile.name}」のこの登録を共有金庫から削除しますか？`, '他の PC へも削除を伝えます。サービス側の MFA は解除しません。新しい登録は発行元の鍵から明示的に作成する必要があります。')) return { outcome: 'cancelled' };
        check();
        if (!this.remote.heads('totp', profile.id).some((entry) => entry.value.registrationId === command.registrationId)) throw new UserError('削除する共有 TOTP の候補が変わりました。');
        await this.add(lease.vaultId, { kind: 'delete', profileId: profile.id, recordId: command.registrationId, parents: [], value: { target: 'totp' } });
      }
      check();
      await this.refresh(authorized);
      return { outcome: 'updated' };
    } finally { lease.key.fill(0); }
  }

  private async linkProfile(profileId: string, bookmarks: boolean, history: boolean, check: () => void): Promise<DataMutation> {
    const space = this.local.settings.association!.vaultId;
    if (this.local.isSuppressed(profileId)) throw new UserError('この端末で削除したプロファイルです。まず明示的に復元してください。');
    if (this.remote.isDeleted(profileId, 'profile', profileId)) throw new UserError('この共有プロファイル UUID は削除されています。新しいプロファイルを作成してください。');
    const installed = this.ui().profiles().find((profile) => profile.id === profileId);
    const heads = this.remote.heads('profile', profileId);
    if (heads.length > 1) throw new UserError('共有プロファイル名が競合しています。先に同期画面で解決してください。');
    const profile = installed ?? heads[0]?.value;
    if (!profile) throw new UserError('共有プロファイルが見つかりません。');
    if (!installed && this.ui().profiles().length >= MAX_PROFILES) throw new UserError('この端末のプロファイル数が上限です。');
    if (installed && heads[0] && this.local.profile(profileId).linkedVaultId !== space
      && (installed.name !== heads[0].value.name || installed.color !== heads[0].value.color)) throw new UserError('同じ UUID のローカル情報が共有情報と異なります。同期画面で内容を解決してから接続してください。');
    const settings = this.local.profile(profileId);
    const localBookmarks = bookmarks && settings.bookmarkSpace !== space ? this.libraryEntries(profileId, 'bookmarks') : [];
    const localHistory = history && settings.historySpace !== space ? this.libraryEntries(profileId, 'history') : [];
    if (localBookmarks.some((entry) => entry.versions.length > 1)) throw new UserError('移行元のブックマーク競合を先に解決してください。');
    const model = this.model(space);
    const bookmarksToCopy = localBookmarks.filter((entry) => !model.heads('bookmark', profileId, entry.id).some((head) =>
      head.value.title === entry.title && head.value.url === entry.url && head.value.createdAt === entry.at));
    const existingVisitIds = new Set(model.library(profileId, 'history', this.now()).map((entry) => entry.id));
    const historyToCopy = localHistory.filter((entry) => !existingVisitIds.has(entry.id));
    const localEntries = this.local.all();
    const localOperationIds = new Set(localEntries.map((entry) => entry.operation.id));
    const projected = localEntries.length + bookmarksToCopy.length + historyToCopy.length
      + this.remote.all().filter((operation) => operation.profileId === profileId && !localOperationIds.has(operation.id)).length + 1;
    if (projected > 100_000) throw new UserError('安全な移行に必要なローカル操作枠が不足しています。元の記録を保持し、移行は開始していません。');
    let totalBookmarks = 0;
    let totalVisits = 0;
    for (const remoteProfile of this.remote.profiles()) {
      totalBookmarks += this.remote.library(remoteProfile, 'bookmarks', this.now()).length;
      totalVisits += this.remote.library(remoteProfile, 'history', this.now()).length;
    }

    if (totalBookmarks + bookmarksToCopy.length > MAX_BOOKMARKS || totalVisits + historyToCopy.length > MAX_VISITS) {
      throw new UserError('移行後の共有ライブラリーが保存上限を超えます。元のデータを変更していません。');
    }
    if (!await this.ui().confirm('プロファイルの同期', `「${profile.name}」をこの金庫に接続しますか？`,
      `UUID: ${profile.id}\nブックマーク: ${bookmarks ? `共有する（移行元 ${localBookmarks.length} 件）` : '共有しない'}\n90日履歴: ${history ? `共有する（移行元 ${localHistory.length} 件）` : '共有しない'}\nTOTP はこの操作では送信・取り込みません。Web サイトへの再サインイン・MFA は通常どおり必要です。`)) return { outcome: 'cancelled' };
    check();
    if (!installed) this.ui().applyProfile(profile);
    for (const operation of this.remote.all()) {
      if (operation.profileId !== profileId || operation.kind === 'totp') continue;
      if (operation.kind === 'bookmark' && !bookmarks) continue;
      if (operation.kind === 'visit' && !history) continue;
      await this.local.commit(space, operation, true);
    }
    this.rebuild();
    await this.ensureProfile(space, profile);
    for (const entry of bookmarksToCopy) {
      check();
      // A new namespace receives explicit live records, not an old vault's secret/history log.
      await this.add(space, { kind: 'bookmark', profileId, recordId: entry.id, parents: [], value: { title: entry.title, url: entry.url, createdAt: entry.at } }, this.now(), true);
    }
    for (const entry of historyToCopy) {
      check();
      const operation = this.model(settings.historySpace).get(entry.revision);
      if (operation?.kind === 'visit') await this.add(space, { kind: 'visit', profileId, recordId: entry.id, parents: [], value: operation.value }, operation.at, true);
    }
    await this.local.updateProfile({
      ...settings, linkedVaultId: space, bookmarks, history,
      bookmarkSpace: bookmarks ? space : settings.bookmarkSpace, historySpace: history ? space : settings.historySpace,
    });
    this.changed();
    await this.refresh();
    return { outcome: 'updated' };
  }

  private async cancelTotpImport(profileId: string): Promise<void> {
    const intent = this.local.intent(profileId);
    if (!intent?.cancelled) throw new UserError('TOTP 移行の取り消しを先に確認してください。');
    this.totp.cancelImport(profileId, intent.next.registrationId, intent.expectedRegistrationId);
    this.local.blockTotpSync(profileId);
    this.rebuild();
    this.invalidateCredentialDisplay();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setup?.key.fill(0);
    this.setup = null;
    this.lifetime.abort();
    this.rootKey?.fill(0);
    this.rootKey = null;
    this.local.dispose();
    this.models.clear();
    this.remote = new VaultModel();
  }
}
