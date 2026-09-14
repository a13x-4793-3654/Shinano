import type { BrowserState, ProfileColor } from '../shared/model.ts';
import {
  MAX_TOTP_INPUT_LENGTH, TOTP_ALGORITHMS, TOTP_DIGITS, TOTP_PERIOD,
  type TotpCode, type TotpMutation, type TotpRegistration,
} from '../shared/totp.ts';
import { create, profileBadge, submitButton } from './dom.ts';

const TRANSPORT_ERROR = 'アプリとの通信に失敗しました。認証コードの操作をやり直してください。';
const INVALID_CODE_ERROR = '認証コードを安全に確認できませんでした。「コードを表示」からやり直してください。';
const INVALID_MUTATION_ERROR = '認証キーの操作結果を確認できませんでした。登録状態を確認してください。';
const PERIOD_MS = TOTP_PERIOD * 1000;
const COLOR_NAMES: Record<ProfileColor, string> = {
  blue: 'ブルー', teal: 'ティール', purple: 'パープル', orange: 'オレンジ', rose: 'ローズ', slate: 'グレー',
};

interface TotpPanelCallbacks {
  selectProfile(profileId: string | null): Promise<boolean>;
  close(): Promise<boolean>;
  reportError(message: string): void;
}

interface Selection {
  profileId: string | null;
  status: TotpRegistration['status'] | null;
  registrationId: string | null;
}

interface PendingAction {
  kind: 'select' | 'register' | 'remove' | 'close';
  profileId: string | null;
}

interface CodeRequest {
  generation: number;
  profileId: string;
  registrationId: string;
  kind: 'get' | 'copy';
}

interface EditorElements {
  form: HTMLFormElement;
  input: HTMLInputElement;
}

interface CodeElements {
  region: HTMLDivElement;
  output: HTMLElement;
  remaining: HTMLParagraphElement;
  issuer: HTMLElement;
  account: HTMLElement;
  parameters: HTMLElement;
  show: HTMLButtonElement;
  hide: HTMLButtonElement;
  copy: HTMLButtonElement;
}

function selectionFor(state: BrowserState): Selection {
  const profileId = state.profiles.some((profile) => profile.id === state.totp.selectedProfileId)
    ? state.totp.selectedProfileId : null;
  const registration = state.totp.registrations.find((entry) => entry.profileId === profileId);
  return {
    profileId,
    status: profileId ? registration?.status ?? 'none' : null,
    registrationId: registration?.status === 'registered' ? registration.registrationId : null,
  };
}

function sameSelection(left: Selection, right: Selection): boolean {
  return left.profileId === right.profileId
    && left.status === right.status
    && left.registrationId === right.registrationId;
}

function inInterval(code: TotpCode, now: number): boolean {
  return code.validFrom <= now && now < code.validUntil;
}

function validCode(code: TotpCode, request: CodeRequest): boolean {
  return typeof code === 'object' && code !== null
    && code.profileId === request.profileId && code.registrationId === request.registrationId
    && typeof code.code === 'string' && code.code.length === TOTP_DIGITS && /^[0-9]{6}$/.test(code.code)
    && TOTP_ALGORITHMS.includes(code.algorithm)
    && code.digits === TOTP_DIGITS && code.period === TOTP_PERIOD
    && (code.issuer === null || typeof code.issuer === 'string')
    && (code.account === null || typeof code.account === 'string')
    && Number.isSafeInteger(code.generatedAt)
    && Number.isSafeInteger(code.validFrom) && code.validFrom >= 0
    && Number.isSafeInteger(code.validUntil)
    && code.validFrom % PERIOD_MS === 0
    && code.validUntil - code.validFrom === PERIOD_MS
    && inInterval(code, code.generatedAt);
}

function text(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

export class TotpPanel {
  private state: BrowserState;
  private selection: Selection;
  private readonly callbacks: TotpPanelCallbacks;
  private readonly surface = create('div', 'surface totp-surface');
  private readonly picker = create('select');
  private readonly profileSummary = create('div', 'totp-profile-summary');
  private readonly profileName = profileBadge('', 'slate');
  private readonly profileColor = create('span', 'totp-profile-color');
  private readonly profileId = create('code', 'totp-profile-id');
  private readonly details = create('section', 'card totp-registration');
  private readonly stateError = create('p', 'totp-state-error');
  private readonly feedback = create('p', 'totp-feedback');
  private readonly backButton: HTMLButtonElement;
  private detailButtons: HTMLButtonElement[] = [];
  private emptyMessage: HTMLParagraphElement | null = null;
  private unreadableError: HTMLParagraphElement | null = null;
  private editor: EditorElements | null = null;
  private codeElements: CodeElements | null = null;
  private editing = false;
  private pendingAction: PendingAction | null = null;
  private codeRequest: CodeRequest | null = null;
  private codeGeneration = 0;
  private code: TotpCode | null = null;
  private revealed = false;
  private timer: number | null = null;
  private disposed = false;

  private readonly onBlur = (): void => {
    this.suspendCode();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.suspendCode();
  };

  constructor(root: HTMLElement, initial: BrowserState, callbacks: TotpPanelCallbacks) {
    this.state = initial;
    this.selection = selectionFor(initial);
    this.callbacks = callbacks;
    this.picker.id = 'totp-profile';
    this.picker.setAttribute('aria-describedby', 'totp-profile-hint');
    this.picker.addEventListener('change', (event) => {
      event.stopPropagation();
      void this.selectProfile(this.picker.value || null);
    });
    this.profileName.id = 'totp-profile-name';
    this.profileColor.id = 'totp-profile-color';
    this.profileId.id = 'totp-profile-id';
    this.profileSummary.setAttribute('aria-label', '選択中のプロファイル');
    this.profileSummary.append('選択中', this.profileName, this.profileColor, this.profileId);
    const pickerLabel = create('label', 'totp-picker-label', '認証コードのプロファイル', this.picker);
    const pickerHint = create('p', 'field-hint',
      '表示名・色・識別子を確認してください。Web サイトのログイン ID を保証するものではありません。');
    pickerHint.id = 'totp-profile-hint';
    this.backButton = this.button('totp-back', 'タブに戻る', 'secondary-button', () => this.close());
    const heading = create('div', 'surface-heading',
      create('div', '', create('p', 'eyebrow', 'LOCAL AUTHENTICATOR'),
        create('h1', '', '認証コード (TOTP)'),
        create('p', 'description', 'プロファイルごとに認証キーを 1 件保存し、必要なときだけコードを表示します。')),
      this.backButton);
    this.stateError.id = 'totp-state-error';
    this.stateError.setAttribute('role', 'alert');
    this.feedback.id = 'totp-feedback';
    this.feedback.hidden = true;
    this.feedback.setAttribute('role', 'status');
    this.feedback.setAttribute('aria-live', 'polite');
    this.surface.append(heading,
      create('section', 'card totp-selector', pickerLabel, pickerHint, this.profileSummary),
      this.stateError, this.feedback, this.details,
      create('p', 'info-box quiet totp-privacy',
        '同じ端末でブラウザーと認証キーを管理すると、別端末の認証器より MFA の独立性が低下します。'
        + 'コピーしたコードは OS のクリップボードや履歴、他のアプリに残る場合があります。'
        + 'クリップボードは自動消去しません。'),
      create('p', 'footnote',
        '登録・削除は Shinano のローカルデータだけを変更します。サービス側の MFA 設定や認証要件は変更しません。'));
    this.renderDetails();
    this.update(initial);
    root.replaceChildren(this.surface);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  update(next: BrowserState): void {
    if (this.disposed || next.revision < this.state.revision) return;
    const nextSelection = selectionFor(next);
    const changed = !sameSelection(this.selection, nextSelection) || this.state.panel !== next.panel;
    this.state = next;
    if (changed) {
      this.resetContext();
      this.selection = nextSelection;
      this.renderDetails();
    }
    this.surface.hidden = next.panel !== 'totp';
    if (this.surface.hidden) {
      this.resetContext();
      this.details.replaceChildren();
      this.clearDetailReferences();
    }
    this.syncProfile();
    text(this.stateError, next.totp.error ?? '');
    this.stateError.hidden = !next.totp.error;
    if (this.unreadableError) text(this.unreadableError, this.registrationError());
    if (this.emptyMessage) text(this.emptyMessage, this.emptyDescription());
    this.syncControls();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.resetContext();
    this.surface.replaceChildren();
    this.clearDetailReferences();
  }

  private button(
    id: string, label: string, className: string, action: () => void | Promise<void>,
  ): HTMLButtonElement {
    const button = create('button', className, label);
    button.id = id;
    button.type = 'button';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!this.disposed && !button.disabled) void action();
    });
    return button;
  }

  private detailButton(
    id: string, label: string, className: string, action: () => void | Promise<void>,
  ): HTMLButtonElement {
    const button = this.button(id, label, className, action);
    this.detailButtons.push(button);
    return button;
  }

  private syncProfile(): void {
    const labels = [
      { value: '', label: 'プロファイルを選択してください' },
      ...this.state.profiles.map((profile) => ({
        value: profile.id, label: `${profile.name} · ${COLOR_NAMES[profile.color]} · ${profile.id.slice(0, 8)}`,
      })),
    ];
    if (this.picker.options.length !== labels.length || labels.some((entry, index) =>
      this.picker.options[index]?.value !== entry.value || this.picker.options[index]?.textContent !== entry.label)) {
      this.picker.replaceChildren(...labels.map((entry) => {
        const option = create('option', '', entry.label);
        option.value = entry.value;
        return option;
      }));
    }
    this.picker.value = (this.pendingAction?.kind === 'select'
      ? this.pendingAction.profileId : this.selection.profileId) ?? '';
    const profile = this.state.profiles.find((entry) => entry.id === this.selection.profileId);
    this.profileSummary.hidden = !profile;
    text(this.profileName, profile?.name ?? '');
    this.profileName.dataset.color = profile?.color ?? 'slate';
    text(this.profileColor, profile ? COLOR_NAMES[profile.color] : '');
    text(this.profileId, profile?.id.slice(0, 8) ?? '');
    this.profileId.title = profile?.id ?? '';
    this.backButton.hidden = !this.state.activeTabId;
  }

  private clearInput(): void {
    if (this.editor) this.editor.input.value = '';
  }

  private clearDetailReferences(): void {
    this.editor = null;
    this.codeElements = null;
    this.emptyMessage = null;
    this.unreadableError = null;
    this.detailButtons = [];
  }

  private emptyDescription(): string {
    return this.state.profiles.length
      ? '上の一覧からプロファイルを選択してください。タブのプロファイルは自動では選択されません。'
      : 'プロファイルがありません。「プロファイル」画面で作成してから、この画面で選択してください。';
  }

  private registrationError(): string {
    const registration = this.state.totp.registrations.find((entry) => entry.profileId === this.selection.profileId);
    return registration?.error ?? '認証キーを読み取れません。';
  }

  private renderDetails(): void {
    this.clearInput();
    this.clearDetailReferences();
    this.details.replaceChildren();
    if (!this.selection.profileId) {
      this.emptyMessage = create('p', 'description', this.emptyDescription());
      this.emptyMessage.id = 'totp-empty';
      this.details.append(create('h2', '', 'プロファイルを選択'), this.emptyMessage);
      return;
    }
    if (this.editing && this.selection.status !== 'unreadable') {
      this.renderEditor();
      return;
    }
    if (this.selection.status === 'unreadable') {
      this.unreadableError = create('p', 'totp-unreadable-error', this.registrationError());
      this.unreadableError.id = 'totp-unreadable-error';
      this.unreadableError.setAttribute('role', 'alert');
      this.details.append(create('h2', '', '登録済みの認証キーを読み取れません'), this.unreadableError,
        create('p', 'description',
          'この登録は表示・上書きできません。削除を確認してから、新しい認証キーを登録してください。'),
        create('div', 'totp-actions',
          this.detailButton('totp-remove', '削除', 'danger-button', () => this.remove())));
      return;
    }
    if (this.selection.status !== 'registered') {
      this.details.append(create('h2', '', '認証キーが未登録です'),
        create('p', 'description', 'このプロファイルに TOTP 認証キーを 1 件登録できます。'),
        create('div', 'totp-actions',
          this.detailButton('totp-add', '認証キーを追加', 'primary-button', () => this.openEditor())));
      return;
    }
    const show = this.button('totp-show', 'コードを表示', 'primary-button', () => this.reveal());
    show.setAttribute('aria-controls', 'totp-code-region');
    const hide = this.button('totp-hide', 'コードを隠す', 'secondary-button', () => this.concealCode());
    const output = create('code', 'totp-code');
    output.id = 'totp-code';
    output.setAttribute('aria-label', '認証コード');
    const remaining = create('p', 'totp-remaining');
    remaining.id = 'totp-remaining';
    remaining.setAttribute('role', 'timer');
    remaining.setAttribute('aria-live', 'off');
    const copy = this.button('totp-copy', 'コピー', 'secondary-button', () => this.copy());
    const issuer = create('dd');
    issuer.id = 'totp-issuer';
    const account = create('dd');
    account.id = 'totp-account';
    const parameters = create('dd');
    parameters.id = 'totp-parameters';
    const metadata = create('dl', 'totp-metadata',
      create('dt', '', '発行者'), issuer, create('dt', '', 'アカウント'), account,
      create('dt', '', '方式'), parameters);
    metadata.id = 'totp-metadata';
    const region = create('div', 'totp-code-region',
      create('div', 'totp-code-frame',
        create('div', '', create('p', 'field-hint', 'ワンタイム認証コード'), output, remaining), copy),
      metadata);
    region.id = 'totp-code-region';
    this.codeElements = { region, output, remaining, issuer, account, parameters, show, hide, copy };
    this.details.append(create('h2', '', '認証キーは登録済みです'),
      create('p', 'description', '表示するまでコードは生成しません。ウィンドウを離れると表示を消去します。'),
      create('div', 'totp-actions', show, hide,
        this.detailButton('totp-replace', '置き換える', 'secondary-button', () => this.openEditor()),
        this.detailButton('totp-remove', '削除', 'danger-button', () => this.remove())),
      region);
    this.syncCode();
  }

  private renderEditor(): void {
    const replacing = this.selection.status === 'registered';
    const input = create('input');
    input.id = 'totp-input';
    input.type = 'password';
    input.maxLength = MAX_TOTP_INPUT_LENGTH;
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.required = true;
    input.placeholder = 'Base32 の認証キー または otpauth://totp/ URI';
    input.setAttribute('aria-describedby', 'totp-import-help totp-base32-help totp-uri-help');
    const localHint = create('p', 'field-hint',
      'この端末内だけに取り込みます。外部への送信や同期は行いません。実際の認証キーや URI をチャットに貼り付けないでください。');
    localHint.id = 'totp-import-help';
    const base32Hint = create('p', 'field-hint',
      'Base32 の認証キーは SHA1・6 桁・30 秒として登録します。文字の区切りには半角スペースだけを使えます。');
    base32Hint.id = 'totp-base32-help';
    const uriHint = create('p', 'field-hint',
      'otpauth://totp/ URI は SHA1 / SHA256 / SHA512 に対応します。6 桁・30 秒のみ対応し、HOTP は使用できません。');
    uriHint.id = 'totp-uri-help';
    const save = submitButton(replacing ? '置き換える' : '登録する');
    save.id = 'totp-save';
    this.detailButtons.push(save);
    const cancel = this.detailButton('totp-cancel', 'キャンセル', 'secondary-button', () => this.cancelEditor());
    const form = create('form', 'totp-form',
      create('label', '', '認証キー / otpauth URI', input),
      create('div', 'totp-import-notes', localHint, base32Hint, uriHint),
      create('div', 'totp-actions', save, cancel));
    form.id = 'totp-register-form';
    form.autocomplete = 'off';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.register(form);
    });
    this.editor = { form, input };
    this.details.append(create('h2', '', replacing ? '認証キーを置き換える' : '認証キーを追加'),
      create('p', 'description', replacing
        ? '保存前に確認画面が開きます。キャンセルした場合は既存の登録を変更しません。'
        : '入力内容は送信直後に消去します。登録後もコードは自動表示しません。'),
      form);
  }

  private syncControls(): void {
    const busy = this.pendingAction !== null;
    this.picker.disabled = busy || !this.state.profiles.length;
    this.backButton.disabled = busy;
    this.details.hidden = this.pendingAction?.kind === 'select' || this.pendingAction?.kind === 'close';
    this.surface.setAttribute('aria-busy', String(busy));
    for (const button of this.detailButtons) button.disabled = busy;
    if (this.editor) this.editor.input.disabled = busy;
    this.syncCode();
  }

  private setFeedback(message: string, error = false): void {
    text(this.feedback, message);
    this.feedback.hidden = !message;
    this.feedback.classList.toggle('totp-feedback-error', error);
    this.feedback.setAttribute('role', error ? 'alert' : 'status');
  }

  private reportError(message: string): void {
    this.setFeedback(message, true);
    this.callbacks.reportError(message);
  }

  private resetContext(): void {
    this.concealCode();
    this.clearInput();
    this.editing = false;
    this.pendingAction = null;
    this.setFeedback('');
  }

  private active(): boolean {
    return !this.disposed && this.state.panel === 'totp';
  }

  private beginAction(kind: PendingAction['kind'], profileId = this.selection.profileId): PendingAction | null {
    if (!this.active() || this.pendingAction) return null;
    const action: PendingAction = { kind, profileId };
    this.pendingAction = action;
    this.syncControls();
    return action;
  }

  private currentAction(action: PendingAction): boolean {
    return this.active() && this.pendingAction === action;
  }

  private finishAction(action: PendingAction): void {
    if (!this.currentAction(action)) return;
    this.pendingAction = null;
    this.syncProfile();
    this.syncControls();
  }

  private async selectProfile(profileId: string | null): Promise<void> {
    if (!this.active() || this.pendingAction || profileId === this.selection.profileId) {
      this.syncProfile();
      return;
    }
    if (profileId !== null && !this.state.profiles.some((profile) => profile.id === profileId)) {
      this.syncProfile();
      return;
    }
    this.resetContext();
    this.renderDetails();
    const action = this.beginAction('select', profileId);
    if (!action) return;
    this.setFeedback('プロファイルを切り替えています…');
    try {
      const success = await this.callbacks.selectProfile(profileId);
      if (!this.currentAction(action)) return;
      if (success) this.setFeedback('');
      else this.reportError('プロファイルを切り替えられませんでした。もう一度お試しください。');
    } catch {
      if (this.currentAction(action)) this.reportError(TRANSPORT_ERROR);
    } finally {
      this.finishAction(action);
    }
  }

  private async close(): Promise<void> {
    if (!this.active() || this.pendingAction) return;
    this.resetContext();
    this.renderDetails();
    const action = this.beginAction('close');
    if (!action) return;
    this.setFeedback('タブに戻っています…');
    try {
      const success = await this.callbacks.close();
      if (!this.currentAction(action)) return;
      if (success) this.setFeedback('');
      else this.reportError('タブに戻れませんでした。もう一度お試しください。');
    } catch {
      if (this.currentAction(action)) this.reportError(TRANSPORT_ERROR);
    } finally {
      this.finishAction(action);
    }
  }

  private openEditor(): void {
    if (!this.active() || this.pendingAction || !this.selection.profileId
      || this.selection.status === 'unreadable') return;
    this.concealCode();
    this.clearInput();
    this.editing = true;
    this.setFeedback('');
    this.renderDetails();
    this.syncControls();
    this.editor?.input.focus();
  }

  private cancelEditor(): void {
    if (!this.active() || this.pendingAction) return;
    this.clearInput();
    this.editing = false;
    this.renderDetails();
    this.syncControls();
    this.setFeedback('認証キーの入力をキャンセルしました。登録は変更していません。');
  }

  private mutationResult(result: TotpMutation, expected: 'saved' | 'removed'): void {
    this.clearInput();
    if (result.outcome === 'cancelled') {
      this.editing = false;
      this.renderDetails();
      this.setFeedback(expected === 'saved'
        ? '登録をキャンセルしました。既存の登録は変更していません。'
        : '削除をキャンセルしました。登録は変更していません。');
    } else if (result.outcome === expected) {
      this.editing = false;
      this.renderDetails();
      this.setFeedback(expected === 'saved'
        ? '認証キーを保存しました。コードは「コードを表示」で確認できます。'
        : '認証キーを削除しました。サービス側の MFA 設定は変更していません。');
    } else {
      this.reportError(INVALID_MUTATION_ERROR);
    }
  }

  private async register(form: HTMLFormElement): Promise<void> {
    if (this.editor?.form !== form) return;
    let input = this.editor.input.value;
    this.editor.input.value = '';
    const profileId = this.selection.profileId;
    if (!this.active() || this.pendingAction || !profileId || this.selection.status === 'unreadable') {
      input = '';
      return;
    }
    if (!input.length || input.length > MAX_TOTP_INPUT_LENGTH) {
      input = '';
      this.reportError('認証キーまたは TOTP URI を 4096 文字以内で入力してください。');
      return;
    }
    this.concealCode();
    const action = this.beginAction('register');
    if (!action) {
      input = '';
      return;
    }
    this.setFeedback('認証キーを登録しています…');
    try {
      const response = window.shinano.totp.register(profileId, input);
      input = '';
      const result = await response;
      if (!this.currentAction(action)) return;
      if (result.ok) this.mutationResult(result.value, 'saved');
      else this.reportError(result.error);
    } catch {
      if (this.currentAction(action)) this.reportError(TRANSPORT_ERROR);
    } finally {
      input = '';
      this.finishAction(action);
    }
  }

  private async remove(): Promise<void> {
    const profileId = this.selection.profileId;
    if (!this.active() || this.pendingAction || !profileId
      || (this.selection.status !== 'registered' && this.selection.status !== 'unreadable')) return;
    this.concealCode();
    this.clearInput();
    const action = this.beginAction('remove');
    if (!action) return;
    this.setFeedback('認証キーの削除を確認しています…');
    try {
      const result = await window.shinano.totp.remove(profileId);
      if (!this.currentAction(action)) return;
      if (result.ok) this.mutationResult(result.value, 'removed');
      else this.reportError(result.error);
    } catch {
      if (this.currentAction(action)) this.reportError(TRANSPORT_ERROR);
    } finally {
      this.finishAction(action);
    }
  }

  private concealCode(): void {
    this.codeGeneration++;
    this.revealed = false;
    this.code = null;
    this.codeRequest = null;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.syncCode();
  }

  private suspendCode(): void {
    if (this.disposed) return;
    const wasRevealed = this.revealed;
    this.concealCode();
    if (wasRevealed) this.setFeedback('認証コードを隠しました。再表示には「コードを表示」を押してください。');
  }

  private reveal(): void {
    if (!this.active() || this.pendingAction || this.editing || this.revealed || document.hidden
      || this.selection.status !== 'registered') return;
    this.concealCode();
    this.revealed = true;
    this.setFeedback('');
    this.timer = window.setInterval(() => this.tick(), 250);
    this.syncCode();
    void this.requestCode('get');
  }

  private syncCode(now = Date.now()): void {
    if (this.revealed && document.hidden) {
      this.suspendCode();
      return;
    }
    if (this.code && (!this.revealed || !inInterval(this.code, now)
      || this.code.profileId !== this.selection.profileId
      || this.code.registrationId !== this.selection.registrationId)) {
      this.code = null;
    }
    const elements = this.codeElements;
    if (!elements) return;
    elements.region.hidden = !this.revealed;
    elements.show.hidden = this.revealed;
    elements.show.disabled = this.pendingAction !== null;
    elements.show.setAttribute('aria-expanded', String(this.revealed));
    elements.hide.hidden = !this.revealed;
    elements.copy.disabled = !this.revealed || !this.code || this.codeRequest !== null || this.pendingAction !== null;
    text(elements.output, this.code?.code ?? '');
    text(elements.remaining, this.code
      ? `残り ${Math.ceil((this.code.validUntil - now) / 1000)} 秒`
      : this.revealed ? 'コードを更新しています…' : '');
    text(elements.issuer, this.code ? this.code.issuer ?? '指定なし' : '');
    text(elements.account, this.code ? this.code.account ?? '指定なし' : '');
    text(elements.parameters, this.code ? `${this.code.algorithm} · ${this.code.digits} 桁 · ${this.code.period} 秒` : '');
  }

  private tick(): void {
    if (!this.active() || !this.revealed) return;
    this.syncCode();
    if (this.revealed && !this.code && !this.codeRequest) void this.requestCode('get');
  }

  private copy(): void {
    if (!this.active() || !this.revealed || this.pendingAction || this.codeRequest) return;
    this.syncCode();
    if (!this.revealed) return;
    if (!this.code) {
      this.tick();
      return;
    }
    void this.requestCode('copy');
  }

  private currentCodeRequest(request: CodeRequest): boolean {
    return this.active() && this.revealed && !document.hidden
      && this.codeRequest === request && this.codeGeneration === request.generation
      && this.selection.profileId === request.profileId
      && this.selection.status === 'registered' && this.selection.registrationId === request.registrationId;
  }

  private async requestCode(kind: CodeRequest['kind']): Promise<void> {
    const { profileId, registrationId, status } = this.selection;
    if (!this.active() || !this.revealed || document.hidden || this.pendingAction || this.codeRequest
      || !profileId || !registrationId || status !== 'registered') return;
    const request: CodeRequest = { generation: this.codeGeneration, profileId, registrationId, kind };
    this.codeRequest = request;
    this.syncCode();
    try {
      const result = kind === 'copy'
        ? await window.shinano.totp.copyCode(profileId, registrationId)
        : await window.shinano.totp.getCode(profileId, registrationId);
      if (!this.currentCodeRequest(request)) return;
      if (!result.ok) {
        this.concealCode();
        this.reportError(result.error);
        return;
      }
      if (!validCode(result.value, request)) {
        this.concealCode();
        this.reportError(INVALID_CODE_ERROR);
        return;
      }
      if (!inInterval(result.value, Date.now())) {
        this.code = null;
        if (kind === 'copy') {
          this.setFeedback('コピーしたコードの有効期限が切れました。更新後にもう一度コピーしてください。');
        }
        return;
      }
      this.code = result.value;
      if (kind === 'copy') this.setFeedback('認証コードをコピーしました。');
    } catch {
      if (this.currentCodeRequest(request)) {
        this.concealCode();
        this.reportError(TRANSPORT_ERROR);
      }
    } finally {
      if (this.codeRequest === request) {
        this.codeRequest = null;
        this.syncCode();
      }
    }
  }
}
