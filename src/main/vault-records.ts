import { createHash } from 'node:crypto';
import type { Profile } from '../shared/model.ts';
import {
  HISTORY_RETENTION_MS, MAX_BOOKMARKS, MAX_VISITS, type LibraryEntry,
} from '../shared/library.ts';
import {
  bookmarkUrl, boundedIds, boundedInteger, historyLocation, libraryTitle,
} from '../shared/library-validation.ts';
import { exactKeys, id, profileColor, profileName, record, UserError } from '../shared/validation.ts';
import { MAX_TOTP_LABEL_LENGTH, MAX_TOTP_SECRET_BYTES, TOTP_ALGORITHMS, type TotpMetadata } from '../shared/totp.ts';

export const MAX_OPERATIONS = 100_000;
export const MAX_CONTROL_OPERATIONS = 50_000;
export const CONTROL_RESERVE = 1024;
export const MAX_MODEL_BYTES = 64 * 1024 * 1024;
export const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

export interface BookmarkValue {
  title: string;
  url: string;
  createdAt: number;
}

export interface VisitValue {
  title: string;
  url: string;
  visitedAt: number;
  mode: 'detailed' | 'origins';
}

export interface PortableTotp extends TotpMetadata {
  registrationId: string;
  key: string;
}

interface OperationBase {
  version: 1;
  id: string;
  writerId: string;
  sequence: number;
  profileId: string;
  recordId: string;
  at: number;
  parents: string[];
}

export type VaultOperation = OperationBase & (
  | { kind: 'profile'; value: Profile }
  | { kind: 'bookmark'; value: BookmarkValue }
  | { kind: 'visit'; value: VisitValue }
  | { kind: 'totp'; value: PortableTotp }
  | { kind: 'delete'; value: { target: 'profile' | 'bookmark' | 'visit' | 'totp' } }
  | { kind: 'history-clear' | 'history-retention'; value: { through: number } }
);

export type OperationKind = VaultOperation['kind'];
export type OperationOf<K extends OperationKind> = Extract<VaultOperation, { kind: K }>;
export type OperationInput = VaultOperation extends infer O
  ? O extends VaultOperation ? Pick<O, 'kind' | 'profileId' | 'recordId' | 'parents' | 'value'> : never : never;

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function label(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || value.length > MAX_TOTP_LABEL_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new UserError('共有 TOTP のラベルの形式が正しくありません。');
  }
  return value;
}

export function parsePortableTotp(input: unknown): PortableTotp {
  const value = record(input);
  exactKeys(value, ['registrationId', 'key', 'algorithm', 'digits', 'period', 'issuer', 'account']);
  const algorithm = TOTP_ALGORITHMS.find((item) => item === value.algorithm);
  if (!algorithm || value.digits !== 6 || value.period !== 30 || typeof value.key !== 'string'
    || value.key.length > Math.ceil(MAX_TOTP_SECRET_BYTES / 3) * 4) {
    throw new UserError('共有 TOTP の形式・アルゴリズム・サイズに対応していません。');
  }
  const bytes = Buffer.from(value.key, 'base64');
  try {
    if (!bytes.length || bytes.length > MAX_TOTP_SECRET_BYTES || bytes.toString('base64') !== value.key) {
      throw new UserError('共有 TOTP の秘密鍵の形式が正しくありません。');
    }
  } finally {
    bytes.fill(0);
  }
  return { registrationId: id(value.registrationId), key: value.key, algorithm, digits: 6, period: 30, issuer: label(value.issuer), account: label(value.account) };
}

export function parseOperation(input: unknown): VaultOperation {
  const value = record(input);
  exactKeys(value, ['version', 'id', 'writerId', 'sequence', 'profileId', 'recordId', 'at', 'parents', 'kind', 'value']);
  if (value.version !== 1) throw new UserError('同期レコードのバージョンに対応していません。既存データは保持しています。');
  const base: OperationBase = {
    version: 1, id: id(value.id), writerId: id(value.writerId), sequence: boundedInteger(value.sequence),
    profileId: id(value.profileId), recordId: id(value.recordId), at: boundedInteger(value.at, 8_640_000_000_000_000),
    parents: boundedIds(value.parents),
  };
  if (!base.sequence || base.parents.includes(base.id)) throw new UserError('同期レコードの順序が正しくありません。');
  const payload = record(value.value);
  if (value.kind === 'profile') {
    exactKeys(payload, ['id', 'name', 'color']);
    if (id(payload.id) !== base.profileId || base.recordId !== base.profileId) throw new UserError('共有プロファイルの ID が一致しません。');
    return { ...base, kind: 'profile', value: { id: base.profileId, name: profileName(payload.name), color: profileColor(payload.color) } };
  }
  if (value.kind === 'bookmark') {
    exactKeys(payload, ['title', 'url', 'createdAt']);
    const createdAt = boundedInteger(payload.createdAt);
    if (createdAt > base.at) throw new UserError('ブックマークの作成日時が正しくありません。');
    return { ...base, kind: 'bookmark', value: { title: libraryTitle(payload.title), url: bookmarkUrl(payload.url), createdAt } };
  }
  if (value.kind === 'totp') {
    if (base.recordId !== base.profileId) throw new UserError('共有 TOTP のプロファイル ID が一致しません。');
    return { ...base, kind: 'totp', value: parsePortableTotp(payload) };
  }
  if (base.parents.length) throw new UserError('この同期レコードに編集元は指定できません。');
  if (value.kind === 'visit') {
    exactKeys(payload, ['title', 'url', 'visitedAt', 'mode']);
    if (payload.mode !== 'detailed' && payload.mode !== 'origins') throw new UserError('履歴の記録方式に対応していません。');
    const url = bookmarkUrl(payload.url);
    if (historyLocation(url, payload.mode) !== url || payload.visitedAt !== base.at) {
      throw new UserError('共有履歴に記録できない URL または日時が含まれています。');
    }
    const title = libraryTitle(payload.title);
    if (payload.mode === 'origins' && title !== new URL(url).hostname) throw new UserError('サイト履歴のタイトルが正しくありません。');
    return { ...base, kind: 'visit', value: { title, url, visitedAt: base.at, mode: payload.mode } };
  }
  if (value.kind === 'delete') {
    exactKeys(payload, ['target']);
    const target = payload.target;
    if (target !== 'profile' && target !== 'bookmark' && target !== 'visit' && target !== 'totp') throw new UserError('削除対象が正しくありません。');
    if (target === 'profile' && base.recordId !== base.profileId) throw new UserError('削除するプロファイル ID が一致しません。');
    return { ...base, kind: 'delete', value: { target } };
  }
  if (value.kind === 'history-clear' || value.kind === 'history-retention') {
    exactKeys(payload, ['through']);
    if (base.recordId !== base.profileId) throw new UserError('履歴のプロファイル ID が一致しません。');
    const through = boundedInteger(payload.through);
    if (through > base.at || (value.kind === 'history-retention' && through > Math.max(0, base.at - HISTORY_RETENTION_MS))) {
      throw new UserError('履歴の削除境界が正しくありません。');
    }
    return { ...base, kind: value.kind, value: { through } };
  }
  throw new UserError('未対応の同期レコードです。パスキー等の未実装形式を取り込みません。');
}

function groupKey(operation: VaultOperation): string {
  return `${operation.profileId}:${operation.kind}:${operation.recordId}`;
}

function deletedKey(profileId: string, target: string, recordId: string): string {
  return `${profileId}:${target}:${recordId}`;
}

export class VaultModel {
  private readonly entries = new Map<string, VaultOperation>();
  private readonly hashes = new Map<string, string>();
  private readonly sequences = new Map<string, string>();
  private readonly writers = new Set<string>();
  private readonly profileIds = new Set<string>();
  private readonly groups = new Map<string, Set<string>>();
  private readonly children = new Map<string, Set<string>>();
  private readonly deleted = new Set<string>();
  private readonly floors = new Map<string, number>();
  private readonly credentials = new Map<string, string>();
  private readonly owners = new Map<string, string>();
  private readonly headCache = new Map<string, VaultOperation[]>();
  private bytes = 0;
  private controls = 0;
  private floor = 0;

  get size(): number { return this.entries.size; }
  get controlCount(): number { return this.controls; }
  all(): VaultOperation[] { return [...this.entries.values()]; }
  get(operationId: string): VaultOperation | undefined { return this.entries.get(operationId); }
  profiles(): string[] { return [...this.profileIds].sort(); }

  validate(input: VaultOperation, now: number): void {
    this.add(input, now, true, false);
  }

  add(input: VaultOperation, now: number, ordinaryWrite = false, apply = true): boolean {
    const operation = parseOperation(input);
    if (operation.at > now + CLOCK_TOLERANCE_MS) throw new UserError('同期データの時計がこの端末より進んでいます。両方の PC の日時を確認して再試行してください。');
    const hash = digest(operation);
    const previous = this.hashes.get(operation.id);
    if (previous) {
      if (previous !== hash) throw new UserError('同じ同期操作 ID の内容が競合しています。既存データは上書きしていません。');
      return false;
    }
    const sequenceKey = `${operation.writerId}:${operation.sequence}`;
    if (this.sequences.has(sequenceKey)) throw new UserError('同期端末の操作番号が分岐しています。データを自動で選択していません。');
    if (operation.kind === 'visit' && operation.at <= this.cutoff(operation.profileId, now)) return false;
    if (!this.writers.has(operation.writerId) && this.writers.size >= 32) throw new UserError('同期端末 ID の上限（32）に達しています。');
    if (!this.profileIds.has(operation.profileId) && this.profileIds.size >= 128) throw new UserError('同期金庫のプロファイル ID の上限（128）に達しています。');
    const length = Buffer.byteLength(JSON.stringify(operation));
    const controlLimit = ordinaryWrite && operation.kind !== 'delete' && operation.kind !== 'history-clear' && operation.kind !== 'history-retention'
      ? MAX_CONTROL_OPERATIONS - CONTROL_RESERVE : MAX_CONTROL_OPERATIONS;
    if (this.entries.size >= MAX_OPERATIONS || this.bytes + length > MAX_MODEL_BYTES
      || (operation.kind !== 'visit' && this.controls >= controlLimit)) {
      throw new UserError('同期データの保存上限に達しました。操作は完了していません。既存データを保持しています。');
    }
    const key = groupKey(operation);
    const ownerKey = operation.kind === 'delete' ? `${operation.value.target}:${operation.recordId}`
      : operation.kind === 'totp' ? `totp:${operation.value.registrationId}`
        : operation.kind === 'profile' || operation.kind === 'bookmark' || operation.kind === 'visit' ? `${operation.kind}:${operation.recordId}` : null;
    const owner = ownerKey ? this.owners.get(ownerKey) : undefined;
    if (owner !== undefined && owner !== operation.profileId) throw new UserError('同じ記録 ID が別のプロファイルに結び付いています。所有権を変更せず取り込みを保留しました。');
    for (const parentId of operation.parents) {
      const parent = this.entries.get(parentId);
      if (parent && groupKey(parent) !== key) throw new UserError('同期レコードの編集元が別の項目に結び付いています。');
    }
    for (const childId of this.children.get(operation.id) ?? []) {
      if (groupKey(this.entries.get(childId)!) !== key) throw new UserError('同期レコードの編集元の対応が一致しません。');
    }
    if (operation.kind === 'visit' && this.groups.has(key)) throw new UserError('訪問 ID の内容が重複・変更されています。');
    if (operation.kind === 'totp') {
      const credentialHash = digest({ profileId: operation.profileId, value: operation.value });
      const old = this.credentials.get(operation.value.registrationId);
      if (old && old !== credentialHash) throw new UserError('同じ TOTP 登録 ID の秘密鍵または設定が異なります。安全のため取り込みを停止しました。');
    }
    const group = this.groups.get(key) ?? new Set<string>();
    // A late parent must not complete a cycle in the immutable revision graph.
    const stack = [...operation.parents];
    const visited = new Set<string>();
    while (stack.length) {
      const next = stack.pop()!;
      if (next === operation.id) throw new UserError('同期の編集履歴が循環しています。');
      if (visited.has(next)) continue;
      visited.add(next);
      const parent = this.entries.get(next);
      if (parent) stack.push(...parent.parents);
    }
    if (!apply) return true;
    this.entries.set(operation.id, operation);
    if (ownerKey) this.owners.set(ownerKey, operation.profileId);
    this.hashes.set(operation.id, hash);
    this.sequences.set(sequenceKey, operation.id);
    this.writers.add(operation.writerId);
    this.profileIds.add(operation.profileId);
    group.add(operation.id);
    this.groups.set(key, group);
    for (const parent of operation.parents) {
      const children = this.children.get(parent) ?? new Set<string>();
      children.add(operation.id);
      this.children.set(parent, children);
    }
    this.headCache.delete(key);
    this.bytes += length;
    if (operation.kind !== 'visit') this.controls++;
    if (operation.kind === 'delete') this.deleted.add(deletedKey(operation.profileId, operation.value.target, operation.recordId));
    if (operation.kind === 'history-clear' || operation.kind === 'history-retention') {
      this.floors.set(operation.profileId, Math.max(this.floors.get(operation.profileId) ?? 0, operation.value.through));
    }
    if (operation.kind === 'totp') this.credentials.set(operation.value.registrationId, digest({ profileId: operation.profileId, value: operation.value }));
    return true;
  }

  cutoff(profileId: string, now: number): number {
    return Math.max(0, this.floor, now - HISTORY_RETENTION_MS, this.floors.get(profileId) ?? 0);
  }

  sharedFloor(profileId: string): number { return this.floors.get(profileId) ?? 0; }

  advanceFloor(value: number): void {
    this.floor = Math.max(this.floor, boundedInteger(value));
  }

  isDeleted(profileId: string, target: string, recordId: string): boolean {
    return this.deleted.has(deletedKey(profileId, 'profile', profileId))
      || this.deleted.has(deletedKey(profileId, target, recordId));
  }

  heads<K extends 'profile' | 'bookmark' | 'totp'>(kind: K, profileId: string, recordId = profileId): OperationOf<K>[] {
    if (this.isDeleted(profileId, kind, recordId)) return [];
    const key = `${profileId}:${kind}:${recordId}`;
    let result = this.headCache.get(key);
    if (!result) {
      const group = this.groups.get(key) ?? new Set<string>();
      const eligible = new Set<string>();
      const pending = new Map<string, number>();
      const children = new Map<string, string[]>();
      const queue: string[] = [];
      for (const operationId of group) {
        const operation = this.entries.get(operationId)!;
        pending.set(operationId, operation.parents.length);
        if (!operation.parents.length) queue.push(operationId);
        for (const parent of operation.parents) children.set(parent, [...(children.get(parent) ?? []), operationId]);
      }
      for (let offset = 0; offset < queue.length; offset++) {
        const operationId = queue[offset]!;
        eligible.add(operationId);
        for (const child of children.get(operationId) ?? []) {
          const remaining = pending.get(child)! - 1;
          pending.set(child, remaining);
          if (!remaining) queue.push(child);
        }
      }
      const superseded = new Set<string>();
      for (const operationId of eligible) for (const parent of this.entries.get(operationId)!.parents) superseded.add(parent);
      result = [...eligible].filter((operationId) => !superseded.has(operationId)).sort().map((operationId) => this.entries.get(operationId)!);
      if (result.length > 32) throw new UserError('同じ記録の競合候補が上限（32）を超えています。');
      this.headCache.set(key, result);
    }
    return result.filter((operation) => operation.kind !== 'totp' || !this.isDeleted(profileId, 'totp', operation.value.registrationId))
      .filter((operation): operation is OperationOf<K> => operation.kind === kind);
  }

  library(profileId: string, kind: 'bookmarks' | 'history', now: number): LibraryEntry[] {
    if (this.isDeleted(profileId, 'profile', profileId)) return [];
    const output: LibraryEntry[] = [];
    if (kind === 'history') {
      for (const operation of this.entries.values()) {
        if (operation.kind !== 'visit' || operation.profileId !== profileId || operation.at <= this.cutoff(profileId, now)
          || this.isDeleted(profileId, 'visit', operation.recordId)) continue;
        output.push({ id: operation.recordId, profileId, title: operation.value.title, url: operation.value.url, at: operation.at, revision: operation.id, versions: [] });
      }
    } else {
      const ids = new Set([...this.entries.values()].filter((entry) => entry.kind === 'bookmark' && entry.profileId === profileId).map((entry) => entry.recordId));
      for (const recordId of ids) {
        const heads = this.heads('bookmark', profileId, recordId);
        const first = heads[0];
        if (!first) continue;
        output.push({
          id: recordId, profileId, title: first.value.title, url: first.value.url, at: first.value.createdAt, revision: first.id,
          versions: heads.map((entry) => ({ revision: entry.id, title: entry.value.title, url: entry.value.url })),
        });
      }
    }
    return output.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  assertLiveLimits(now: number): void {
    let bookmarks = 0;
    let visits = 0;
    for (const profileId of this.profiles()) {
      bookmarks += this.library(profileId, 'bookmarks', now).length;
      visits += this.library(profileId, 'history', now).length;
    }
    if (bookmarks > MAX_BOOKMARKS || visits > MAX_VISITS) throw new UserError('ブックマークまたは90日履歴の件数上限を超えています。同期の競合・件数を確認してください。');
  }

  hasPending(): boolean {
    for (const operation of this.entries.values()) {
      if (operation.parents.some((parent) => !this.entries.has(parent))) return true;
      if (operation.kind !== 'profile' && operation.kind !== 'delete'
        && !this.isDeleted(operation.profileId, 'profile', operation.profileId) && !this.heads('profile', operation.profileId).length) return true;
    }
    return false;
  }
}
