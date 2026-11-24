import {
  MAX_BACKUP_PASSPHRASE_LENGTH, MIN_BACKUP_PASSPHRASE_LENGTH, type BackupResult,
} from '../shared/backup.ts';
import { create, submitButton } from './dom.ts';

export class BackupPanel {
  private readonly inputs: HTMLInputElement[] = [];
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly feedback = create('p', 'totp-feedback');
  private busy = false;
  private disposed = false;
  private restored = false;
  private readonly clear = (): void => {
    for (const input of this.inputs) input.value = '';
  };
  private readonly onVisibility = (): void => {
    if (document.hidden) this.clear();
  };

  constructor(root: HTMLElement, close: () => Promise<boolean>) {
    const back = create('button', 'secondary-button', 'プロファイルに戻る');
    back.type = 'button';
    back.addEventListener('click', () => {
      if (!this.busy && !this.restored) {
        this.clear();
        void close();
      }
    });
    this.buttons.push(back);
    this.feedback.id = 'backup-feedback';
    this.feedback.setAttribute('role', 'status');
    this.feedback.setAttribute('aria-live', 'polite');
    root.replaceChildren(create('div', 'surface',
      create('div', 'surface-heading',
        create('div', '', create('p', 'eyebrow', 'ENCRYPTED BACKUP'), create('h1', '', 'OneDrive バックアップ'),
          create('p', 'description', 'プロファイルと TOTP 認証キーを暗号化して保存し、別端末で復元します。')), back),
      create('p', 'info-box', 'OneDrive の同期フォルダーを保存先に選んでください。同期は OneDrive アプリが行います。'
        + '別端末ではファイルの同期完了を待って復元してください。Cookie・サインイン状態は含みません。'),
      create('p', 'info-box quiet', 'パスフレーズは 12 文字以上の十分に長いものを使い、別の安全な場所で管理してください。'
        + 'パスフレーズを知る人は TOTP 認証キーを復元できます。忘れると復号できません。チャットには送らないでください。'),
      this.form('export'), this.form('import'), this.feedback));
    window.addEventListener('blur', this.clear);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    window.removeEventListener('blur', this.clear);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private input(id: string): HTMLInputElement {
    const input = create('input');
    input.id = id;
    input.type = 'password';
    input.required = true;
    input.minLength = MIN_BACKUP_PASSPHRASE_LENGTH;
    input.maxLength = MAX_BACKUP_PASSPHRASE_LENGTH;
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    this.inputs.push(input);
    return input;
  }

  private form(kind: 'export' | 'import'): HTMLFormElement {
    const passphrase = this.input(`backup-${kind}-passphrase`);
    const confirm = kind === 'export' ? this.input('backup-export-confirm') : null;
    const button = submitButton(kind === 'export' ? '暗号化して保存' : 'バックアップを復元');
    button.id = `backup-${kind}`;
    this.buttons.push(button);
    const form = create('form', 'card totp-form',
      create('h2', '', kind === 'export' ? 'OneDrive に保存' : '別端末から復元'),
      create('label', '', 'パスフレーズ', passphrase));
    form.autocomplete = 'off';
    if (confirm) form.append(create('label', '', 'パスフレーズ（確認）', confirm));
    if (kind === 'import') form.append(create('p', 'field-hint',
      '既存のプロファイルは上書きしません。同じ ID がある場合は復元を中止します。復元後は再起動が必要です。'));
    form.append(button);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.busy || this.disposed || this.restored) return;
      const value = passphrase.value;
      const matches = !confirm || confirm.value === value;
      this.clear();
      if (!matches) {
        this.message('確認用パスフレーズが一致しません。入力し直してください。', true);
        return;
      }
      void this.execute(kind, value);
    });
    return form;
  }

  private message(value: string, error = false): void {
    this.feedback.textContent = value;
    this.feedback.setAttribute('role', error ? 'alert' : 'status');
    this.feedback.classList.toggle('totp-feedback-error', error);
  }

  private controls(): void {
    for (const node of [...this.inputs, ...this.buttons]) node.disabled = this.busy || this.restored;
  }

  private async execute(kind: 'export' | 'import', passphrase: string): Promise<void> {
    this.busy = true;
    this.controls();
    this.message('ファイルと確認画面を処理しています…');
    try {
      const response = window.shinano.backup[kind](passphrase);
      passphrase = '';
      const result = await response;
      if (this.disposed) return;
      if (!result.ok) this.message(result.error, true);
      else this.result(result.value);
    } catch {
      if (!this.disposed) this.message('アプリとの通信に失敗しました。保存・復元の状態を確認してから再試行してください。', true);
    } finally {
      passphrase = '';
      this.clear();
      this.busy = false;
      this.controls();
    }
  }

  private result(result: BackupResult): void {
    if (result.outcome === 'saved') this.message('暗号化バックアップを保存しました。OneDrive の同期完了を確認してください。');
    else if (result.outcome === 'cancelled') this.message('操作をキャンセルしました。データは変更していません。');
    else if (result.outcome === 'restored') {
      this.restored = true;
      this.message('復元データを保存しました。Shinano を終了して再起動してください。再起動まで変更操作はできません。');
    } else this.message('操作結果を確認できません。保存・復元の状態を確認してください。', true);
  }
}
