import type { BrowserState, ProfileColor } from '../shared/model.ts';
import type {
  FolderSelection, JoinVaultRequest, SyncCommand, SyncPhase, SyncProfile, SyncStatus, UnlockVaultRequest,
} from '../shared/sync.ts';
import { create, profileBadge, submitButton } from './dom.ts';

const TRANSPORT_ERROR = 'アプリとの通信に失敗しました。操作結果は未確認です。状態を再取得してからやり直してください。';
const PHASES: Record<SyncPhase, string> = {
  unconfigured: '未設定', locked: 'ロック中', ready: '解除済み', busy: '選択したフォルダーを処理中',
  unavailable: 'フォルダーまたは保護機能を利用できません', error: 'エラー・要確認',
};
const COLORS: Record<ProfileColor, string> = {
  blue: 'ブルー', teal: 'ティール', purple: 'パープル', orange: 'オレンジ', rose: 'ローズ', slate: 'グレー',
};

// Serialize setup cleanup across panel instances; a late cancellation must not cancel a newer setup.
let setupWork: Promise<void> = Promise.resolve();
let setupCleanupError: string | null = null;

function scheduleSetup(work: () => Promise<void>): Promise<void> {
  const result = setupWork.then(work, work);
  setupWork = result.catch(() => {});
  return result;
}

async function discardSetup(): Promise<string | null> {
  try {
    const result = await window.shinano.sync.command({ type: 'cancel-setup' });
    setupCleanupError = result.ok ? null : result.error;
  } catch {
    setupCleanupError = TRANSPORT_ERROR;
  }
  return setupCleanupError;
}

interface SyncPanelCallbacks {
  close(): Promise<boolean>;
  reportError(message: string): void;
}

interface Action {
  context: number;
  kind: 'choose' | 'create' | 'join' | 'unlock' | 'command' | 'passphrase';
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLButtonElement;

export class SyncPanel {
  private state: BrowserState;
  private snapshot: SyncStatus | null = null;
  private selection: FolderSelection | null = null;
  private setupMode: 'create' | 'join' | null = null;
  private setupId: string | null = null;
  private recovery: { output: HTMLElement; acknowledged: HTMLInputElement } | null = null;
  private profileId: string | null;
  private readonly surface = create('div', 'surface sync-surface');
  private readonly summary = create('section', 'card sync-summary');
  private readonly stateError = create('p', 'data-error');
  private readonly statusError = create('p', 'data-error');
  private readonly feedback = create('p', 'data-feedback');
  private readonly wrappingWarning = create('p', 'data-error');
  private readonly connection = create('section', 'card sync-connection');
  private readonly profiles = create('section', 'card sync-profiles');
  private readonly profilePicker = create('select');
  private readonly profileList = create('ul', 'sync-profile-list');
  private readonly profileDetails = create('div', 'sync-profile-details');
  private readonly passphrase = create('section', 'card sync-passphrase');
  private readonly back: HTMLButtonElement;
  private controls: { node: Control; available: () => boolean }[] = [];
  private connectionKey = '';
  private profileKey = '';
  private renderedProfile: SyncProfile | null = null;
  private passphraseVisible = false;
  private statusGeneration = 0;
  private context = 0;
  private secretGeneration = 0;
  private loading = false;
  private statusFailed = false;
  private pending: Action | null = null;
  private disposed = false;

  private readonly onBlur = (): void => {
    this.secretGeneration++;
    const hadInput = this.clearSecrets();
    if (this.setupId) {
      void this.cancelSetup('画面を離れたため、復旧キーの表示と作成を中止しました。作成をやり直してください。');
    } else if (hadInput && !this.pending) {
      this.setFeedback('画面を離れたため、秘密の入力内容を消去しました。');
    }
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.onBlur();
  };

  constructor(root: HTMLElement, initial: BrowserState, private readonly callbacks: SyncPanelCallbacks) {
    this.state = initial;
    const activeTab = initial.tabs.find((tab) => tab.id === initial.activeTabId);
    this.profileId = activeTab?.profileId ?? null;
    this.back = this.button('sync-back', 'タブに戻る', 'secondary-button', () => this.close(), () => true);
    this.stateError.id = 'sync-state-error';
    this.statusError.id = 'sync-status-error';
    this.feedback.id = 'sync-feedback';
    this.wrappingWarning.id = 'sync-wrapping-conflict';
    this.statusError.hidden = true;
    this.feedback.hidden = true;
    for (const error of [this.stateError, this.statusError, this.wrappingWarning]) error.setAttribute('role', 'alert');
    this.feedback.setAttribute('role', 'status');
    this.profilePicker.id = 'sync-profile';
    this.track(this.profilePicker, () => !this.pending && Boolean(this.snapshot?.profiles.length));
    this.profilePicker.addEventListener('change', (event) => {
      event.stopPropagation();
      const value = this.profilePicker.value || null;
      if (value !== null && !this.snapshot?.profiles.some((profile) => profile.id === value)) return;
      this.advanceContext();
      this.profileId = value;
      this.profileKey = '';
      if (this.setupId) void this.cancelSetup('プロファイルを切り替えたため、保管庫の作成を中止しました。');
      this.renderProfiles();
      this.syncControls();
    });
    this.profiles.append(create('h2', '', 'プロファイルごとの連携・取り込み'),
      create('p', 'description',
        '同じ名前でも識別子が異なるプロファイルは別物です。フォルダーの選択・保管庫への参加だけでは、既存データを共有しません。'
        + '対象とカテゴリを選び、プロファイルごとに連携を確認してください。認証キーの共有はさらに別の操作です。'),
      this.profileList, create('label', 'data-field', '操作するプロファイル', this.profilePicker), this.profileDetails);
    this.surface.append(
      create('div', 'surface-heading',
        create('div', '', create('p', 'eyebrow', 'ENCRYPTED FOLDER VAULT'), create('h1', '', 'データの同期'),
          create('p', 'description',
            'アプリで暗号化したデータを、選択したフォルダーに読み書きします。別の PC への配送は OneDrive などの外部クライアントが行います。')),
        this.back),
      this.stateError, this.statusError, this.feedback, this.summary, this.wrappingWarning,
      create('div', 'data-actions',
        this.button('sync-status-retry', '状態を再取得', 'secondary-button', () => this.loadStatus(), () => !this.loading)),
      this.connection, this.profiles, this.passphrase,
      create('p', 'info-box quiet',
        '保管庫のロックは、共有鍵と共有認証キーの利用を止めます。ローカルのブックマーク・履歴や既存のブラウザーセッションは引き続き利用でき、'
        + '共有していないローカル TOTP 登録は変わりません。'),
      create('p', 'footnote',
        'Cookie・ログイントークン・タブ・サイトデータ・ダウンロードは共有しません。'
        + '表示できるのは選択したローカルフォルダーの読み書きの状態だけです。クラウドへの配信や別端末の受信、バックアップの完了は確認しません。'));
    root.replaceChildren(this.surface);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.syncIndicator();
    this.renderStatus();
    void this.loadStatus();
  }

  update(next: BrowserState): void {
    if (this.disposed || next.revision < this.state.revision) return;
    const changedData = next.data.revision !== this.state.data.revision;
    const changedGeneration = next.data.generation !== this.state.data.generation;
    this.state = next;
    if (next.panel !== 'sync') {
      this.surface.hidden = true;
      this.invalidate();
      return;
    }
    this.surface.hidden = false;
    if (changedGeneration) {
      this.secretGeneration++;
      this.clearSecrets();
      if (this.setupId) void this.cancelSetup('保管庫の状態が変わったため、作成を中止しました。状態を確認してやり直してください。');
    }
    this.syncIndicator();
    if (changedData) void this.loadStatus();
    else this.syncControls();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.invalidate();
    this.snapshot = null;
    this.selection = null;
    this.surface.replaceChildren();
    this.controls = [];
  }

  private active(): boolean {
    return !this.disposed && this.state.panel === 'sync';
  }

  private ready(): boolean {
    return this.snapshot?.phase === 'ready' && !this.statusFailed && !this.pending && !this.setupId;
  }

  private profileReady(): boolean {
    return this.ready() && !this.snapshot?.wrappingConflict;
  }

  private track<T extends Control>(node: T, available: () => boolean = () => !this.pending): T {
    this.controls.push({ node, available });
    return node;
  }

  private button(
    id: string, label: string, className: string, action: () => void | Promise<void>,
    available: () => boolean = () => !this.pending,
  ): HTMLButtonElement {
    const button = this.track(create('button', className, label), available);
    button.id = id;
    button.type = 'button';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.active() && !button.disabled) void action();
    });
    return button;
  }

  private secret(id: string, newPassword = false): HTMLInputElement {
    const input = this.track(create('input'));
    input.id = id;
    input.type = 'password';
    input.autocomplete = newPassword ? 'new-password' : 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.maxLength = 1024;
    input.required = true;
    return input;
  }

  private checkbox(id: string, label: string, checked = false): { input: HTMLInputElement; label: HTMLLabelElement } {
    const input = this.track(create('input'));
    input.type = 'checkbox';
    input.id = id;
    input.checked = checked;
    return { input, label: create('label', 'data-checkbox', input, label) };
  }

  private form(id: string, children: (Node | string)[], submit: () => void | Promise<void>): HTMLFormElement {
    const form = create('form', 'data-form', ...children);
    form.id = id;
    form.autocomplete = 'off';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.active() && form.isConnected && !this.pending) void submit();
    });
    return form;
  }

  private clearSecrets(root: HTMLElement = this.surface): boolean {
    let hadInput = false;
    for (const input of root.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
      hadInput ||= Boolean(input.value);
      input.value = '';
    }
    return hadInput;
  }

  private clearRecovery(): void {
    if (this.recovery) {
      this.recovery.output.textContent = '';
      this.recovery.acknowledged.checked = false;
    }
    this.recovery = null;
  }

  private invalidate(): void {
    this.advanceContext(false);
    const hadSetup = this.setupId !== null;
    this.setupId = null;
    this.clearRecovery();
    if (hadSetup) void scheduleSetup(async () => { await discardSetup(); });
  }

  private advanceContext(refetch = true): void {
    const wasLoading = this.loading;
    this.context++;
    this.secretGeneration++;
    this.statusGeneration++;
    this.loading = false;
    this.clearSecrets();
    this.pending = null;
    if (refetch && wasLoading && this.active()) void this.loadStatus();
  }

  private syncIndicator(): void {
    this.stateError.textContent = this.state.data.error ?? '';
    this.stateError.hidden = !this.state.data.error;
    this.back.hidden = !this.state.activeTabId;
  }

  private async loadStatus(): Promise<void> {
    if (!this.active()) return;
    const generation = ++this.statusGeneration;
    const context = this.context;
    this.loading = true;
    this.syncControls();
    try {
      const result = await window.shinano.sync.status();
      if (!this.active() || context !== this.context || generation !== this.statusGeneration) return;
      if (!result.ok) {
        this.statusFailure(result.error);
        return;
      }
      if (result.value.generation < this.state.data.generation) {
        this.statusFailure('保管庫の状態が変わりました。古い状態では操作せず、状態を再取得してください。');
        return;
      }
      this.statusFailed = false;
      this.statusError.textContent = '';
      this.statusError.hidden = true;
      this.snapshot = result.value;
      this.renderStatus();
    } catch {
      if (this.active() && context === this.context && generation === this.statusGeneration) this.statusFailure(TRANSPORT_ERROR);
    } finally {
      if (this.active() && context === this.context && generation === this.statusGeneration) {
        this.loading = false;
        this.syncControls();
      }
    }
  }

  private statusFailure(message: string): void {
    this.statusFailed = true;
    this.statusError.textContent = `${message} ${this.snapshot ? '下の表示は前回取得した状態です。' : '保管庫の状態は未確認です。'}`;
    this.statusError.hidden = false;
    if (!this.snapshot) {
      this.summary.replaceChildren(create('h2', '', '選択したフォルダーの状態'),
        create('p', 'description', '状態を取得できませんでした。「状態を再取得」でやり直してください。'));
    }
    this.syncControls();
  }

  private renderStatus(): void {
    const status = this.snapshot;
    this.summary.replaceChildren(create('h2', '', '選択したフォルダーの状態'));
    if (!status) {
      this.summary.append(create('p', 'description', '状態を取得しています。設定や保存の成功はまだ確認していません。'));
      this.connection.hidden = true;
      this.profiles.hidden = true;
      this.passphrase.hidden = true;
      this.wrappingWarning.hidden = true;
      return;
    }
    const timestamp = (value: number | null): string => value === null ? '未確認' : new Date(value).toLocaleString('ja-JP');
    const detail = create('dl', 'data-metadata',
      create('dt', '', '状態'), create('dd', '', PHASES[status.phase]),
      create('dt', '', 'フォルダー'), create('dd', 'data-path', status.folder ?? '未選択'),
      create('dt', '', '保管庫 ID'), create('dd', '', status.vaultId ?? '未設定'),
      create('dt', '', '未反映・保留'), create('dd', '', `${status.pending} 件`),
      create('dt', '', 'フォルダーの最終読み取り'), create('dd', '', timestamp(status.lastReadAt)),
      create('dt', '', 'フォルダーへの最終書き込み'), create('dd', '', timestamp(status.lastWriteAt)),
      create('dt', '', 'この端末の共有鍵キャッシュ'), create('dd', '', status.hasDeviceKey ? 'OS の保護機能で保存済み' : 'なし'));
    this.summary.append(detail,
      create('p', status.phase === 'error' || status.phase === 'unavailable' ? 'data-error' : 'field-hint',
        status.message ?? (status.phase === 'error' || status.phase === 'unavailable'
          ? '安全な読み書きを確認できません。フォルダーと OS の保護機能を確認し、状態を再取得してください。'
          : 'これらの日時はローカルフォルダーの処理だけを示します。外部クライアントの配信完了ではありません。')));
    this.wrappingWarning.hidden = !status.wrappingConflict;
    this.wrappingWarning.textContent = status.wrappingConflict
      ? 'マスターパスフレーズの変更が競合しています。自動で版を選びません。信頼する端末で保管庫を解除し、確認済みの新しいパスフレーズで競合を解消してください。'
      : '';
    this.renderConnection();
    this.renderProfiles();
    this.renderPassphrase();
    this.syncControls();
  }

  private renderConnection(): void {
    const status = this.snapshot;
    if (!status) return;
    this.connection.hidden = false;
    const mode = !status.vaultId ? 'setup'
      : status.phase === 'locked' ? 'locked'
        : status.phase === 'ready' || status.phase === 'busy' ? 'open' : 'blocked';
    const key = this.setupId ? `recovery:${this.setupId}`
      : `${mode}:${status.vaultId ?? ''}:${status.hasDeviceKey}:${this.selection?.selectionId ?? ''}:${this.setupMode ?? ''}`;
    if (key === this.connectionKey) return;
    if (this.setupId && this.recovery) return;
    this.connectionKey = key;
    this.clearSecrets(this.connection);
    this.connection.replaceChildren();
    if (mode === 'setup') {
      this.renderSetupChoice();
      return;
    }
    this.connection.append(create('h2', '', mode === 'locked' ? '保管庫のロックを解除' : 'この端末の保管庫との接続'));
    if (mode === 'locked') this.renderUnlock();
    if (mode === 'blocked') {
      this.connection.append(create('p', 'data-error',
        '状態を確認できないため、共有データの変更は行えません。上のエラー（読み取り専用・整合性・形式・容量上限など）とフォルダーの状態を確認してください。'));
    }
    const actions = create('div', 'data-actions');
    if (mode !== 'locked') {
      actions.append(
        this.button('sync-refresh', 'フォルダーを再読み取り・書き込み', 'secondary-button',
          () => this.command({ type: 'refresh' }, '選択したフォルダーの処理結果を再取得しました。クラウド配信は確認していません。')),
        this.button('sync-lock', '保管庫をロック', 'secondary-button',
          () => this.command({ type: 'lock' }, '共有保管庫をロックしました。ローカルのライブラリやブラウザーセッションは引き続き利用できます。')));
    }
    if (status.hasDeviceKey) actions.append(
      this.button('sync-forget', 'この端末の共有鍵を忘れる', 'danger-button',
        () => this.command({ type: 'forget' }, 'この端末の共有鍵キャッシュを削除しました。他の端末や保管庫のファイルは失効・削除していません。')));
    actions.append(this.button('sync-unlink', 'この端末と保管庫の関連付けを解除', 'danger-button',
      () => this.command({ type: 'unlink' }, 'この端末の関連付けを解除しました。共有保管庫や他の端末のデータは削除していません。')));
    this.connection.append(actions, create('p', 'field-hint',
      '解除・忘却の範囲は操作時の確認画面で確認してください。別フォルダーへ切り替えるには、先に関連付けを明示的に解除します。'
      + '共有鍵を忘れても、他の端末の鍵やクラウドに残る過去のファイルは失効しません。'));
  }

  private renderSetupChoice(): void {
    this.connection.append(create('h2', '', '共有フォルダーを選択'),
      create('p', 'description',
        '選択だけでは既存のライブラリや認証キーをアップロードしません。作成・参加の後も、連携するプロファイルとカテゴリを個別に確認します。'),
      create('div', 'data-actions',
        this.button('sync-choose-folder', this.selection ? 'フォルダーを選び直す' : 'フォルダーを選択', 'primary-button',
          () => this.chooseFolder(), () => !this.pending && !this.statusFailed)));
    const selection = this.selection;
    if (!selection) return;
    this.connection.append(create('p', 'data-path', selection.displayPath),
      create('p', 'field-hint', `このフォルダーで見つかった保管庫: ${selection.vaultIds.length} 件`),
      create('div', 'data-actions',
        this.button('sync-new-vault', '新しい保管庫を作成', 'secondary-button', () => this.selectSetupMode('create')),
        this.button('sync-existing-vault', '既存の保管庫に参加', 'secondary-button', () => this.selectSetupMode('join'),
          () => !this.pending && selection.vaultIds.length > 0)));
    if (this.setupMode === 'create') this.renderCreate();
    if (this.setupMode === 'join') this.renderJoin(selection);
  }

  private selectSetupMode(mode: 'create' | 'join' | null): void {
    this.advanceContext();
    this.setupMode = mode;
    this.connectionKey = '';
    this.renderConnection();
    this.setFeedback('');
    this.syncControls();
  }

  private passphraseHint(): HTMLElement {
    return create('p', 'field-hint',
      '無作為に選んだ複数の単語など、推測されにくい 20 文字以上・UTF-8 で 1024 バイト以内のパスフレーズを使用してください。'
      + '空白・大文字小文字はそのまま区別し、正規化しません。長さだけで安全性は保証できません。実際の秘密をチャットに貼り付けないでください。');
  }

  private renderCreate(): void {
    const passphrase = this.secret('sync-create-passphrase', true);
    const confirmation = this.secret('sync-create-confirmation', true);
    const remember = this.checkbox('sync-create-remember', 'この端末に共有鍵を記憶する（OS の保護機能が利用できる場合のみ）');
    const submit = this.track(submitButton('復旧キーを生成して確認'));
    submit.id = 'sync-create-submit';
    this.connection.append(this.form('sync-create-form', [
      create('h3', '', '新しい保管庫のマスターパスフレーズ'),
      create('label', 'data-field', 'マスターパスフレーズ', passphrase),
      create('label', 'data-field', '確認のため再入力', confirmation),
      this.passphraseHint(), remember.label,
      create('p', 'field-hint',
        '次に一度だけ復旧キーを表示します。安全に保管したことを確認するまで作成は完了しません。'
        + 'パスフレーズ・復旧キー・利用可能な信頼済み端末をすべて失うと、復旧できなくなる場合があります。'),
      create('div', 'data-actions', submit,
        this.button('sync-create-cancel', '作成を中止', 'secondary-button', () => this.cancelSetup(), () => true)),
    ], () => this.createVault(passphrase, confirmation, remember.input.checked)));
  }

  private methodPicker(id: string, device: boolean): HTMLSelectElement {
    const picker = this.track(create('select'));
    picker.id = id;
    const methods = [
      { id: 'passphrase', label: 'マスターパスフレーズ' },
      { id: 'recovery', label: '復旧キー' },
      ...(device ? [{ id: 'device', label: 'この端末に記憶した共有鍵' }] : []),
    ];
    for (const method of methods) {
      const option = create('option', '', method.label);
      option.value = method.id;
      picker.append(option);
    }
    picker.addEventListener('change', (event) => {
      event.stopPropagation();
      this.secretGeneration++;
      this.clearSecrets();
    });
    return picker;
  }

  private renderJoin(selection: FolderSelection): void {
    const vault = this.track(create('select'));
    vault.id = 'sync-join-vault';
    for (const vaultId of selection.vaultIds) {
      const option = create('option', '', vaultId);
      option.value = vaultId;
      vault.append(option);
    }
    vault.addEventListener('change', (event) => {
      event.stopPropagation();
      this.secretGeneration++;
      this.clearSecrets();
    });
    const method = this.methodPicker('sync-join-method', false);
    const input = this.secret('sync-join-input');
    const remember = this.checkbox('sync-join-remember', 'この端末に共有鍵を記憶する（OS の保護機能を使用）');
    const submit = this.track(submitButton('この保管庫に参加'));
    submit.id = 'sync-join-submit';
    this.connection.append(this.form('sync-join-form', [
      create('label', 'data-field', '参加する保管庫 ID（識別子を確認）', vault),
      create('label', 'data-field', '解除方法', method),
      create('label', 'data-field', 'パスフレーズ / 復旧キー', input), remember.label,
      create('p', 'field-hint', '参加後にプロファイルの識別子を確認し、取り込む対象を明示的に選びます。認証キーを自動で取り込むことはありません。'),
      create('div', 'data-actions', submit,
        this.button('sync-join-cancel', 'キャンセル', 'secondary-button', () => this.selectSetupMode(null))),
    ], () => {
      let secret = input.value;
      input.value = '';
      const value = method.value;
      if (value !== 'passphrase' && value !== 'recovery') { secret = ''; return; }
      const request: JoinVaultRequest = {
        selectionId: selection.selectionId, vaultId: vault.value, method: value, input: secret, remember: remember.input.checked,
      };
      secret = '';
      return this.accessVault(request);
    }));
  }

  private renderUnlock(): void {
    const method = this.methodPicker('sync-unlock-method', this.snapshot?.hasDeviceKey ?? false);
    const input = this.secret('sync-unlock-input');
    const field = create('label', 'data-field', 'パスフレーズ / 復旧キー', input);
    method.addEventListener('change', () => {
      field.hidden = method.value === 'device';
      input.required = method.value !== 'device';
    });
    const submit = this.track(submitButton('ロックを解除'));
    submit.id = 'sync-unlock-submit';
    this.connection.append(this.form('sync-unlock-form', [
      create('label', 'data-field', '解除方法', method), field,
      create('p', 'field-hint', 'この端末に記憶した共有鍵の利用にも、OS の保護機能が必要です。パスフレーズや復旧キーは送信直後に入力欄から消去します。'),
      submit,
    ], () => {
      let secret = input.value;
      input.value = '';
      const value = method.value;
      if (value !== 'passphrase' && value !== 'recovery' && value !== 'device') { secret = ''; return; }
      const request: UnlockVaultRequest = { method: value, input: value === 'device' ? '' : secret };
      secret = '';
      return this.accessVault(request);
    }));
  }

  private async chooseFolder(): Promise<void> {
    const action = this.begin('choose');
    if (!action) return;
    this.clearSecrets();
    this.setFeedback('フォルダーの選択を待っています。選択だけではデータを共有しません。');
    try {
      const result = await window.shinano.sync.chooseFolder();
      if (!this.current(action)) return;
      if (!result.ok) { this.reportError(result.error); return; }
      if (!result.value) { this.setFeedback('フォルダーの選択をキャンセルしました。'); return; }
      this.selection = result.value;
      this.setupMode = null;
      this.connectionKey = '';
      this.renderConnection();
      this.setFeedback('フォルダーを選択しました。保管庫の作成または参加を選んでください。データはまだ共有していません。');
    } catch {
      if (this.current(action)) this.reportError(TRANSPORT_ERROR);
    } finally {
      this.finish(action);
    }
  }

  private async createVault(passphraseInput: HTMLInputElement, confirmationInput: HTMLInputElement, remember: boolean): Promise<void> {
    let passphrase = passphraseInput.value;
    let confirmation = confirmationInput.value;
    passphraseInput.value = '';
    confirmationInput.value = '';
    const selectionId = this.selection?.selectionId;
    const secretGeneration = this.secretGeneration;
    if (!selectionId) { passphrase = ''; confirmation = ''; return; }
    const action = this.begin('create');
    if (!action) { passphrase = ''; confirmation = ''; return; }
    this.setFeedback('復旧キーを生成しています。この画面を離れると作成を中止します。');
    await scheduleSetup(async () => {
      try {
        if (setupCleanupError && await discardSetup()) {
          if (this.current(action)) this.reportError(`前の作成の中止を確認できませんでした。${setupCleanupError}`);
          return;
        }
        if (!this.current(action)) return;
        if (secretGeneration !== this.secretGeneration || document.hidden || !document.hasFocus()) {
          this.setFeedback('画面を離れたため、生成を中止しました。この画面で作成をやり直してください。');
          return;
        }
        const response = window.shinano.sync.create({ selectionId, passphrase, confirmation, remember });
        passphrase = '';
        confirmation = '';
        const result = await response;
        if (!result.ok) {
          if (this.current(action)) this.reportError(result.error);
          return;
        }
        const setupId = result.value.setupId;
        let recoveryKey = result.value.recoveryKey;
        try {
          if (!this.current(action) || secretGeneration !== this.secretGeneration || document.hidden || !document.hasFocus()
            || this.selection?.selectionId !== selectionId) {
            recoveryKey = '';
            const error = await discardSetup();
            if (this.current(action)) {
              if (error) this.reportError(error);
              else this.setFeedback('画面を離れたか状態が変わったため、作成を中止しました。この画面で作成をやり直してください。');
            }
            return;
          }
          this.showRecovery(setupId, recoveryKey);
        } finally {
          recoveryKey = '';
        }
      } catch {
        const error = await discardSetup();
        if (this.current(action)) this.reportError(error ?? TRANSPORT_ERROR);
      } finally {
        passphrase = '';
        confirmation = '';
        this.finish(action);
      }
    });
  }

  private showRecovery(setupId: string, key: string): void {
    this.clearSecrets(this.connection);
    this.clearRecovery();
    this.connection.replaceChildren();
    this.setupId = setupId;
    this.connectionKey = `recovery:${setupId}`;
    const output = create('code', 'sync-recovery-key', key);
    output.id = 'sync-recovery-key';
    output.setAttribute('aria-label', '一度だけ表示する復旧キー');
    const acknowledged = this.checkbox('sync-recovery-acknowledged', '復旧キーを安全に保管した');
    acknowledged.input.addEventListener('change', () => this.syncControls());
    this.recovery = { output, acknowledged: acknowledged.input };
    this.connection.append(create('h2', '', '復旧キーを安全に保管してください'),
      create('p', 'description',
        'このキーは一度だけ表示します。保管庫を開ける秘密です。安全な場所に手動で保管してください。自動でコピーしたり、平文ファイルに保存したりしません。'
        + 'この画面を離れると表示を消去し、作成を中止します。'),
      output, acknowledged.label,
      create('div', 'data-actions',
        this.button('sync-finish-create', '保管したことを確認して作成を完了', 'primary-button', () => this.finishCreate(),
          () => !this.pending && Boolean(this.recovery?.acknowledged.checked)),
        this.button('sync-cancel-setup', '作成を中止してキーを消去', 'secondary-button', () => this.cancelSetup(), () => true)));
    this.setFeedback('保管庫の作成はまだ完了していません。復旧キーを安全に保管し、確認してください。');
  }

  private async finishCreate(): Promise<void> {
    const setupId = this.setupId;
    if (!setupId || !this.recovery?.acknowledged.checked) return;
    const action = this.begin('command');
    if (!action) return;
    this.setupId = null;
    this.clearRecovery();
    this.connection.replaceChildren(create('p', 'description', '保管庫の作成を完了しています…'));
    this.connectionKey = '';
    await scheduleSetup(async () => {
      try {
        if (!this.current(action)) { await discardSetup(); return; }
        const result = await window.shinano.sync.command({ type: 'finish-create', setupId, recoveryAcknowledged: true });
        if (!this.current(action)) { await discardSetup(); return; }
        if (!result.ok || result.value.outcome === 'cancelled') {
          const error = await discardSetup();
          this.reportError(error ?? (!result.ok ? result.error : '保管庫の作成をキャンセルしました。作成をやり直してください。'));
          return;
        }
        if (result.value.outcome !== 'saved' && result.value.outcome !== 'updated') {
          await discardSetup();
          this.reportError('保管庫の作成結果を確認できませんでした。状態を再取得してください。');
          return;
        }
        this.selection = null;
        this.setupMode = null;
        this.setFeedback('保管庫を作成しました。連携するプロファイルとカテゴリを、下で個別に選んでください。');
      } catch {
        const error = await discardSetup();
        if (this.current(action)) this.reportError(error ?? TRANSPORT_ERROR);
      } finally {
        if (this.current(action)) {
          this.setupMode = null;
          this.connectionKey = '';
          await this.loadStatus();
          this.renderConnection();
        }
        this.finish(action);
      }
    });
  }

  private async cancelSetup(message = '作成の中止を要求しました。入力と復旧キーの表示を消去し、進行中の生成結果も表示せず破棄します。'): Promise<void> {
    const hadSetup = this.setupId !== null;
    this.advanceContext();
    this.setupId = null;
    this.clearRecovery();
    this.setupMode = null;
    this.connectionKey = '';
    if (this.active()) {
      this.renderConnection();
      this.setFeedback(message);
      this.syncControls();
    }
    if (!hadSetup) return;
    const context = this.context;
    await scheduleSetup(async () => {
      const error = await discardSetup();
      if (!this.active() || context !== this.context) return;
      if (error) this.reportError(`作成の中止を確認できませんでした。${error}`);
      else this.setFeedback('保管庫の作成を中止しました。作成をやり直す場合は新しい復旧キーを保管してください。');
      await this.loadStatus();
    });
  }

  private async accessVault(request: JoinVaultRequest | UnlockVaultRequest): Promise<void> {
    const joining = 'selectionId' in request;
    const expectedVaultId = joining ? request.vaultId : this.snapshot?.vaultId;
    const action = this.begin(joining ? 'join' : 'unlock');
    if (!action) { request.input = ''; return; }
    this.setFeedback(joining ? '保管庫を確認して参加しています…' : '保管庫のロックを解除しています…');
    try {
      const response = joining ? window.shinano.sync.join({ ...request }) : window.shinano.sync.unlock({ ...request });
      request.input = '';
      const result = await response;
      if (!this.current(action)) return;
      if (!result.ok) { this.reportError(result.error); return; }
      if (result.value.generation < this.state.data.generation) {
        this.reportError('保管庫の状態が変わりました。古い操作結果は表示せず、現在の状態を確認します。');
        return;
      }
      if (!expectedVaultId || result.value.vaultId !== expectedVaultId) {
        this.reportError('選択した保管庫と操作結果の識別子が一致しません。状態を再取得して確認してください。');
        return;
      }
      if (joining) {
        this.selection = null;
        this.setupMode = null;
      }
      this.snapshot = result.value;
      this.statusFailed = false;
      this.statusError.textContent = '';
      this.statusError.hidden = true;
      this.connectionKey = '';
      this.renderStatus();
      if (result.value.phase !== 'ready' && result.value.phase !== 'busy') {
        this.reportError(result.value.message ?? '保管庫の解除は確認できませんでした。表示された状態を確認してください。');
        return;
      }
      this.setFeedback(joining
        ? '保管庫に参加しました。取り込むプロファイルとカテゴリを確認してください。認証キーは別途、登録ごとに選択します。'
        : '保管庫の解除結果を取得しました。フォルダーの状態とエラー表示を確認してください。');
    } catch {
      if (this.current(action)) this.reportError(TRANSPORT_ERROR);
    } finally {
      request.input = '';
      if (this.current(action)) await this.loadStatus();
      this.finish(action);
    }
  }

  private profileLabel(profile: SyncProfile): string {
    return `${profile.versions.length > 1 ? '表示名が競合中' : profile.name} · ${COLORS[profile.color]} · ${profile.id.slice(0, 8)}`;
  }

  private renderProfiles(): void {
    const status = this.snapshot;
    this.profiles.hidden = !status;
    if (!status) return;
    if (this.profileId && !status.profiles.some((profile) => profile.id === this.profileId)) {
      this.profileId = null;
      this.advanceContext();
    }
    const options = [
      { id: '', label: '操作するプロファイルを選択してください' },
      ...status.profiles.map((profile) => ({ id: profile.id, label: this.profileLabel(profile) })),
    ];
    if (this.profilePicker.options.length !== options.length || options.some((option, index) =>
      this.profilePicker.options[index]?.value !== option.id || this.profilePicker.options[index]?.textContent !== option.label)) {
      this.profilePicker.replaceChildren(...options.map((value) => {
        const option = create('option', '', value.label);
        option.value = value.id;
        return option;
      }));
    }
    this.profilePicker.value = this.profileId ?? '';
    this.profileList.replaceChildren(...status.profiles.map((profile) => create('li', '',
      profileBadge(profile.versions.length > 1 ? '表示名が競合中' : profile.name, profile.color),
      create('code', '', profile.id),
      create('span', '', `${profile.installed ? '導入済み' : '未導入'} · ${profile.suppressed ? 'この端末では非表示' : '非表示指定なし'} · ${profile.linked ? '連携中' : '未連携'}`))));
    if (!status.profiles.length) this.profileList.append(create('li', '', '操作できるプロファイルはありません。'));
    const profile = status.profiles.find((entry) => entry.id === this.profileId);
    const key = JSON.stringify(profile ?? null);
    if (key === this.profileKey) return;
    const previous = this.renderedProfile;
    const keepCategories = profile && previous?.id === profile.id
      && previous.linked === profile.linked && previous.bookmarks === profile.bookmarks && previous.history === profile.history;
    const bookmarkChoice = keepCategories ? this.profileDetails.querySelector<HTMLInputElement>('#sync-profile-bookmarks')?.checked : undefined;
    const historyChoice = keepCategories ? this.profileDetails.querySelector<HTMLInputElement>('#sync-profile-history')?.checked : undefined;
    this.profileKey = key;
    this.renderedProfile = profile ?? null;
    this.profileDetails.replaceChildren();
    if (!profile) {
      this.profileDetails.append(create('p', 'field-hint', '一覧の識別子を確認し、操作するプロファイルを選んでください。'));
      return;
    }
    this.profileDetails.append(create('div', 'data-profile-summary',
      profileBadge(profile.versions.length > 1 ? '表示名が競合中' : profile.name, profile.color), create('code', '', profile.id)),
    create('p', 'field-hint', '連携・取り込み・削除は保管庫の解除後に行います。競合がある項目は、各版を比較して明示的に解決してください。'));
    const bookmarks = this.checkbox('sync-profile-bookmarks', 'ブックマークを連携する', bookmarkChoice ?? (profile.linked && profile.bookmarks));
    const history = this.checkbox('sync-profile-history', '閲覧履歴を連携する', historyChoice ?? (profile.linked && profile.history));
    this.profileDetails.append(bookmarks.label, history.label,
      create('p', 'field-hint',
        '履歴にはパス・タイトルの秘密が含まれる可能性があります。カテゴリの解除は記録の削除ではなく、履歴の記録方法も変更しません。'),
      create('div', 'data-actions',
        this.button('sync-profile-link', profile.linked ? '連携するカテゴリを保存'
          : profile.installed ? 'このプロファイルの連携を確認' : 'このプロファイルを取り込み・連携', 'primary-button',
        () => this.command({
          type: 'profile:link', profileId: profile.id, bookmarks: bookmarks.input.checked, history: history.input.checked,
        }, 'プロファイルの連携設定を反映しました。認証キーは自動共有しません。'),
        () => this.profileReady() && !profile.suppressed && profile.versions.length <= 1)));
    const actions = create('div', 'data-actions');
    if (profile.linked) actions.append(this.button('sync-profile-unlink', 'この端末のプロファイル連携を解除', 'secondary-button',
      () => this.command({ type: 'profile:unlink', profileId: profile.id }, 'この端末のプロファイル連携を解除しました。共有記録の削除ではありません。'),
      () => this.profileReady()));
    if (profile.suppressed) actions.append(this.button('sync-profile-restore', 'この端末に復元することを確認', 'secondary-button',
      () => this.command({ type: 'profile:restore', profileId: profile.id }, 'プロファイルの復元結果を取得しました。連携するカテゴリを確認してください。'),
      () => this.profileReady()));
    if (profile.linked || profile.versions.length || profile.sharedRegistrationId) {
      actions.append(this.button('sync-profile-delete', '共有保管庫からプロファイルを削除', 'danger-button',
        () => this.command({ type: 'profile:delete', profileId: profile.id },
          '共有プロファイルの削除を記録しました。クラウドの過去の版や、他端末のサイトデータを消去するものではありません。'),
        () => this.profileReady()));
    }
    this.profileDetails.append(actions,
      create('p', 'field-hint',
        '共有保管庫からの削除は、共有ライブラリと関連する共有認証キーにも影響します。'
        + '他端末の Cookie やブラウザーセッション、サービス側のアカウントは削除しません。削除範囲は別の確認画面で確認します。'));
    if (profile.versions.length > 1) {
      this.profileDetails.append(create('h3', '', 'プロファイルの表示名・色の競合'));
      for (const version of profile.versions) {
        this.profileDetails.append(create('section', 'data-conflict',
          create('div', 'data-profile-summary', profileBadge(version.name, version.color),
            create('span', '', COLORS[version.color]), create('code', '', version.revision)),
          this.button(`sync-profile-resolve-${version.revision}`, 'この版の表示名・色を採用', 'secondary-button',
            () => this.command({ type: 'profile:resolve', profileId: profile.id, revision: version.revision }, '選んだ版でプロファイルの競合を解決しました。'),
            () => this.profileReady())));
      }
    }
    this.renderTotp(profile);
  }

  private renderTotp(profile: SyncProfile): void {
    const section = create('section', 'sync-totp',
      create('h3', '', '認証キー (TOTP) の登録ごとの共有'),
      create('p', 'info-box quiet',
        '同じ端末でブラウザーと認証キーを管理すると、別端末の認証器より MFA の独立性が低下します。'
        + 'この画面では認証キーの秘密やコードは表示しません。共有は登録ごとの明示的な確認が必要で、サービス側の MFA 設定は変更しません。'),
      create('p', 'field-hint', `この端末の登録 ID: ${profile.localRegistrationId ?? 'なし'} · 共有登録 ID: ${profile.sharedRegistrationId ?? 'なし'}`));
    const labels: Record<SyncProfile['totpState'], string> = {
      none: '共有済みの認証キーはありません', available: '確認して取り込める共有登録があります',
      linked: '共有登録と連携中', conflict: '共有登録が競合しています。自動では選びません', unreadable: '認証キーを読み取れません。上書きせず、状態を確認してください',
      pending: '認証キーの移行処理が保留中です。通常の共有・取り込みは、移行の完了または取り消しまで利用できません',
    };
    section.append(create('p', profile.totpState === 'unreadable' || profile.totpState === 'conflict' ? 'data-error' : 'field-hint',
      labels[profile.totpState]));
    if (profile.totpState === 'pending') {
      section.append(create('p', 'field-hint',
        '取り消しはこの端末の未完了の移行だけを対象にし、以前の OS 保護された登録を復元するか、未確定の初回取り込みを除去します。'
        + '保管庫のロック中・エラー時にも実行できますが、OS の保護機能が必要です。共有保管庫の登録を削除する操作ではありません。'),
      create('div', 'data-actions',
        this.button('sync-totp-cancel-import', '未完了の TOTP 移行を取り消す', 'danger-button',
          () => this.command({ type: 'totp:cancel-import', profileId: profile.id },
            '未完了の TOTP 移行を取り消しました。ローカルの登録状態を確認してください。共有保管庫の登録は削除していません。'),
          () => !this.pending)));
    }
    const registrationId = profile.localRegistrationId;
    const canChangeRegistration = (): boolean => this.profileReady() && profile.installed && profile.linked
      && !profile.suppressed && profile.totpState !== 'unreadable' && profile.totpState !== 'pending';
    if (registrationId) section.append(create('div', 'data-actions',
      this.button('sync-totp-share', 'この端末の登録を共有することを確認', 'secondary-button',
        () => this.command({ type: 'totp:share', profileId: profile.id, registrationId }, '選択した登録の共有操作を反映しました。別端末の受信は確認していません。'),
        canChangeRegistration)));
    const registrations = new Set<string>();
    for (const version of profile.totpVersions) {
      registrations.add(version.registrationId);
      const versionSection = create('section', 'data-conflict sync-totp-version',
        create('div', 'data-profile-summary', profileBadge(profile.versions.length > 1 ? '表示名が競合中' : profile.name, profile.color),
          create('code', '', profile.id)),
        create('dl', 'data-metadata',
          create('dt', '', '発行者'), create('dd', '', version.issuer ?? '未指定'),
          create('dt', '', 'アカウント'), create('dd', '', version.account ?? '未指定'),
          create('dt', '', '登録 ID'), create('dd', '', version.registrationId),
          create('dt', '', '版'), create('dd', '', version.revision)),
        create('div', 'data-actions',
          this.button(`sync-totp-accept-${version.revision}`, 'この共有登録をこの端末で使用することを確認', 'secondary-button',
            () => this.command({
              type: 'totp:accept', profileId: profile.id, revision: version.revision, expectedRegistrationId: profile.localRegistrationId,
            }, '選択した共有登録の取り込み結果を取得しました。認証コード画面で登録を確認してください。'),
            canChangeRegistration),
          this.totpDelete(profile.id, version.registrationId, version.revision)));
      section.append(versionSection);
    }
    if (profile.sharedRegistrationId && !registrations.has(profile.sharedRegistrationId)) {
      section.append(create('div', 'data-actions', this.totpDelete(profile.id, profile.sharedRegistrationId, 'current')));
    }
    section.append(create('p', 'field-hint',
      '共有登録の削除は他の連携端末にも反映する操作です。この端末だけの登録変更・削除とは別に確認します。'
      + 'ローカルで置き換えた登録や読み取れない登録を自動で上書きしません。'));
    this.profileDetails.append(section);
  }

  private totpDelete(profileId: string, registrationId: string, revision: string): HTMLButtonElement {
    return this.button(`sync-totp-delete-${revision}`, 'この登録を共有保管庫から削除', 'danger-button',
      () => this.command({ type: 'totp:delete', profileId, registrationId },
        '選択した共有登録の削除を記録しました。サービス側の MFA 登録やクラウドの過去の版は削除していません。'),
      () => this.profileReady());
  }

  private renderPassphrase(): void {
    const status = this.snapshot;
    const visible = Boolean(status?.vaultId && (status.phase === 'ready' || status.phase === 'busy'));
    this.passphrase.hidden = !visible;
    if (visible === this.passphraseVisible) return;
    this.passphraseVisible = visible;
    this.clearSecrets(this.passphrase);
    this.passphrase.replaceChildren();
    if (!visible) return;
    const passphrase = this.secret('sync-new-passphrase', true);
    const confirmation = this.secret('sync-new-confirmation', true);
    const acknowledged = this.checkbox('sync-change-warning', '変更しても古い鍵や過去のファイルは失効しないことを理解した');
    acknowledged.input.required = true;
    const submit = this.track(submitButton('マスターパスフレーズを変更'), () => this.ready() && acknowledged.input.checked);
    submit.id = 'sync-change-passphrase';
    acknowledged.input.addEventListener('change', () => this.syncControls());
    this.passphrase.append(create('h2', '', 'マスターパスフレーズの変更・競合の解消'),
      create('p', 'info-box',
        '変更は鍵の包み直しであり、失効や全データの再暗号化ではありません。'
        + '古いパスフレーズとクラウド履歴に残る古いラッパー（暗号化した共有鍵）、またはオフライン端末の共有鍵があれば、データを引き続き復号できる場合があります。'
        + '古いラッパー・クラウドの版履歴・オフライン端末の鍵は、この変更では失効しません。'),
      this.form('sync-passphrase-form', [
        create('label', 'data-field', '新しいマスターパスフレーズ', passphrase),
        create('label', 'data-field', '確認のため再入力', confirmation), this.passphraseHint(), acknowledged.label,
        create('div', 'data-actions', submit,
          this.button('sync-change-cancel', '入力を消去', 'secondary-button', () => {
            passphrase.value = '';
            confirmation.value = '';
            acknowledged.input.checked = false;
            this.syncControls();
          })),
      ], () => this.changePassphrase(passphrase, confirmation, acknowledged.input.checked)));
  }

  private async changePassphrase(passphraseInput: HTMLInputElement, confirmationInput: HTMLInputElement, acknowledged: boolean): Promise<void> {
    let passphrase = passphraseInput.value;
    let confirmation = confirmationInput.value;
    passphraseInput.value = '';
    confirmationInput.value = '';
    if (!acknowledged || !this.ready()) { passphrase = ''; confirmation = ''; return; }
    const action = this.begin('passphrase');
    if (!action) { passphrase = ''; confirmation = ''; return; }
    this.setFeedback('マスターパスフレーズの変更を確認しています…');
    try {
      const response = window.shinano.sync.changePassphrase({ passphrase, confirmation });
      passphrase = '';
      confirmation = '';
      const result = await response;
      if (!this.current(action)) return;
      if (!result.ok) this.reportError(result.error);
      else if (result.value.outcome === 'cancelled') this.setFeedback('パスフレーズの変更をキャンセルしました。');
      else if (result.value.outcome === 'saved' || result.value.outcome === 'updated') {
        this.setFeedback('パスフレーズ変更の操作を反映しました。古いラッパーやオフライン端末の鍵は失効していません。');
      } else this.reportError('パスフレーズの変更結果を確認できませんでした。状態を再取得してください。');
    } catch {
      if (this.current(action)) this.reportError(TRANSPORT_ERROR);
    } finally {
      passphrase = '';
      confirmation = '';
      if (this.current(action)) await this.loadStatus();
      this.finish(action);
    }
  }

  private async command(command: SyncCommand, message: string): Promise<void> {
    const action = this.begin('command');
    if (!action) return;
    if (command.type === 'lock' || command.type === 'forget' || command.type === 'unlink') {
      this.secretGeneration++;
      this.clearSecrets();
    }
    this.setFeedback('対象と範囲を確認しています…');
    try {
      const result = await window.shinano.sync.command(command);
      if (!this.current(action)) return;
      if (!result.ok) this.reportError(result.error);
      else if (result.value.outcome === 'cancelled') this.setFeedback('操作をキャンセルしました。');
      else if (result.value.outcome === 'saved' || result.value.outcome === 'updated' || result.value.outcome === 'removed') {
        this.setFeedback(message);
      } else this.reportError('操作結果を確認できませんでした。状態を再取得してください。');
    } catch {
      if (this.current(action)) this.reportError(TRANSPORT_ERROR);
    } finally {
      if (this.current(action)) await this.loadStatus();
      this.finish(action);
    }
  }

  private begin(kind: Action['kind']): Action | null {
    if (!this.active() || this.pending) return null;
    const action: Action = { kind, context: this.context };
    this.pending = action;
    this.syncControls();
    return action;
  }

  private current(action: Action): boolean {
    return this.active() && this.pending === action && action.context === this.context;
  }

  private finish(action: Action): void {
    if (!this.current(action)) return;
    this.pending = null;
    this.syncControls();
  }

  private syncControls(): void {
    this.controls = this.controls.filter((control) => this.surface.contains(control.node));
    for (const control of this.controls) control.node.disabled = !this.active() || !control.available();
    this.surface.setAttribute('aria-busy', String(this.loading || this.pending !== null));
    this.summary.setAttribute('aria-busy', String(this.loading));
  }

  private setFeedback(message: string, error = false): void {
    this.feedback.textContent = message;
    this.feedback.hidden = !message;
    this.feedback.classList.toggle('data-error', error);
    this.feedback.setAttribute('role', error ? 'alert' : 'status');
  }

  private reportError(message: string): void {
    this.setFeedback(message, true);
    this.callbacks.reportError(message);
  }

  private async close(): Promise<void> {
    this.invalidate();
    try {
      if (!await this.callbacks.close() && this.active()) {
        this.connectionKey = '';
        this.renderConnection();
        this.reportError('タブに戻れませんでした。秘密の表示は消去しました。');
        await this.loadStatus();
      }
    } catch {
      if (this.active()) this.reportError(TRANSPORT_ERROR);
    }
  }
}
