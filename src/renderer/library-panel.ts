import type { BrowserState, ProfileColor } from '../shared/model.ts';
import {
  HISTORY_DAYS, LIBRARY_PAGE_SIZE, MAX_LIBRARY_TITLE, MAX_LIBRARY_URL,
  type HistoryMode, type LibraryCommand, type LibraryCursor, type LibraryEntry,
  type LibraryKind, type LibraryPage, type LibraryVersion,
} from '../shared/library.ts';
import { create, profileBadge, submitButton } from './dom.ts';

const TRANSPORT_ERROR = 'アプリとの通信に失敗しました。ライブラリの状態を確認してから、操作をやり直してください。';
const COLORS: Record<ProfileColor, string> = {
  blue: 'ブルー', teal: 'ティール', purple: 'パープル', orange: 'オレンジ', rose: 'ローズ', slate: 'グレー',
};

interface LibraryPanelCallbacks {
  close(): Promise<boolean>;
  reportError(message: string): void;
}

interface BookmarkEditor {
  form: HTMLFormElement;
  profileId: string;
  recordId: string | null;
  parents: string[];
  title: HTMLInputElement;
  url: HTMLInputElement;
}

export class LibraryPanel {
  private state: BrowserState;
  private kind: LibraryKind;
  private profileId: string | null;
  private readonly surface = create('div', 'surface library-surface');
  private readonly heading = create('h1');
  private readonly picker = create('select');
  private readonly summary = create('div', 'data-profile-summary');
  private readonly search = create('input');
  private readonly stateError = create('p', 'data-error');
  private readonly queryError = create('p', 'data-error');
  private readonly feedback = create('p', 'data-feedback');
  private readonly preferences = create('section', 'card library-preferences');
  private readonly editorRegion = create('section', 'card library-editor');
  private readonly results = create('div', 'library-results');
  private readonly count = create('p', 'field-hint');
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly add: HTMLButtonElement;
  private readonly back: HTMLButtonElement;
  private page: LibraryPage | null = null;
  private cursors: (LibraryCursor | null)[] = [null];
  private pageIndex = 0;
  private query = '';
  private editor: BookmarkEditor | null = null;
  private pending: object | null = null;
  private context = 0;
  private inputGeneration = 0;
  private queryGeneration = 0;
  private loading = false;
  private disposed = false;

  private readonly onBlur = (): void => {
    this.inputGeneration++;
    const hadInput = Boolean(this.editor?.title.value || this.editor?.url.value);
    if (this.editor) {
      this.editor.title.value = '';
      this.editor.url.value = '';
    }
    if (hadInput && !this.pending) this.setFeedback('画面を離れたため、編集中の入力内容を消去しました。');
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.onBlur();
  };

  constructor(
    root: HTMLElement, initial: BrowserState, private readonly callbacks: LibraryPanelCallbacks,
  ) {
    this.state = initial;
    this.kind = initial.panel === 'history' ? 'history' : 'bookmarks';
    this.profileId = this.activeProfile();
    this.back = this.button('library-back', 'タブに戻る', 'secondary-button', () => this.close());
    this.add = this.button('library-add-current', '現在のページを追加', 'primary-button', () => this.addCurrent());
    this.picker.id = 'library-profile';
    this.picker.addEventListener('change', (event) => {
      event.stopPropagation();
      const profileId = this.picker.value || null;
      if (profileId !== null && !this.state.profiles.some((profile) => profile.id === profileId)) return;
      this.resetContext();
      this.profileId = profileId;
      this.syncProfile();
      void this.loadPage();
    });
    this.search.id = 'library-query';
    this.search.type = 'search';
    this.search.maxLength = 256;
    this.search.autocomplete = 'off';
    this.search.autocapitalize = 'off';
    this.search.spellcheck = false;
    this.search.placeholder = 'タイトル・URL を検索';
    const searchForm = create('form', 'library-search',
      create('label', 'grow', '検索', this.search), submitButton('検索', 'secondary-button'));
    searchForm.autocomplete = 'off';
    searchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!this.active() || this.pending) return;
      this.query = this.search.value;
      this.resetPagination();
      void this.loadPage();
    });
    const retry = this.button('library-retry', '一覧を再取得', 'secondary-button', () => {
      this.resetPagination();
      return this.loadPage();
    });
    this.previous = this.button('library-previous', '前の 100 件', 'secondary-button', () => {
      if (!this.page || this.pageIndex === 0) return;
      this.pageIndex--;
      return this.loadPage();
    });
    this.next = this.button('library-next', '次の 100 件', 'secondary-button', () => {
      if (!this.page?.next) return;
      this.cursors[this.pageIndex + 1] = this.page.next;
      this.pageIndex++;
      return this.loadPage();
    });
    this.stateError.id = 'library-state-error';
    this.queryError.id = 'library-query-error';
    this.stateError.setAttribute('role', 'alert');
    this.queryError.setAttribute('role', 'alert');
    this.feedback.id = 'library-feedback';
    this.feedback.hidden = true;
    this.feedback.setAttribute('role', 'status');
    this.count.setAttribute('aria-live', 'polite');
    this.results.id = 'library-results';
    this.results.setAttribute('aria-label', 'ライブラリの検索結果');
    this.editorRegion.hidden = true;
    this.surface.append(
      create('div', 'surface-heading',
        create('div', '', create('p', 'eyebrow', 'PROFILE LIBRARY'), this.heading,
          create('p', 'description', '保存先のプロファイルを確認してください。表示名や色は、サイトのログイン ID を保証しません。')),
        this.back),
      create('section', 'card data-selector',
        create('label', 'data-field', '表示するプロファイル', this.picker), this.summary, searchForm),
      this.stateError, this.feedback, this.preferences,
      create('div', 'data-actions', this.add, retry),
      this.editorRegion, this.queryError, this.count, this.results,
      create('nav', 'data-actions library-pagination', this.previous, this.next),
      create('p', 'footnote',
        '「この端末から削除」はローカル表示だけを対象にします。「共有保管庫から削除」は、連携先にも反映する別の操作です。'
        + '削除前に対象と範囲を確認する画面が開きます。クラウドの版履歴や、オフライン端末のファイルまで消去するものではありません。'));
    root.replaceChildren(this.surface);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.syncProfile();
    this.syncState();
    void this.loadPage();
  }

  update(next: BrowserState): void {
    if (this.disposed || next.revision < this.state.revision) return;
    const changedData = next.data.revision !== this.state.data.revision;
    const changedGeneration = next.data.generation !== this.state.data.generation;
    const changedProfiles = JSON.stringify(next.profiles) !== JSON.stringify(this.state.profiles);
    this.state = next;
    if (next.panel !== 'bookmarks' && next.panel !== 'history') {
      this.resetContext();
      this.surface.hidden = true;
      return;
    }
    this.surface.hidden = false;
    const changedKind = next.panel !== this.kind;
    const missingProfile = this.profileId !== null && !next.profiles.some((profile) => profile.id === this.profileId);
    if (changedKind || missingProfile) {
      this.resetContext();
      this.kind = next.panel;
      this.profileId = this.activeProfile();
    } else if (changedGeneration) {
      this.inputGeneration++;
      this.clearEditor();
    }
    this.syncProfile();
    this.syncState();
    if (changedKind || missingProfile || changedData) {
      this.resetPagination();
      void this.loadPage();
    } else {
      if (changedProfiles && this.page) this.renderResults();
      this.syncControls();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.resetContext();
    this.surface.replaceChildren();
  }

  addCurrent(): void {
    if (!this.active() || this.kind !== 'bookmarks' || this.pending || document.hidden) return;
    void this.captureCurrent();
  }

  private active(): boolean {
    return !this.disposed && (this.state.panel === 'bookmarks' || this.state.panel === 'history');
  }

  private activeProfile(): string | null {
    const tab = this.state.tabs.find((entry) => entry.id === this.state.activeTabId);
    return this.state.profiles.find((profile) => profile.id === tab?.profileId)?.id ?? null;
  }

  private button(
    id: string, label: string, className: string, action: () => void | Promise<void>, vault = false,
  ): HTMLButtonElement {
    const button = create('button', className, label);
    button.id = id;
    button.type = 'button';
    if (vault) button.dataset.vaultAction = 'true';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.active() && !button.disabled) void action();
    });
    return button;
  }

  private syncProfile(): void {
    const options = [
      { id: '', label: 'すべてのプロファイル（一覧のみ）' },
      ...this.state.profiles.map((profile) => ({
        id: profile.id, label: `${profile.name} · ${COLORS[profile.color]} · ${profile.id.slice(0, 8)}`,
      })),
    ];
    if (this.picker.options.length !== options.length || options.some((option, index) =>
      this.picker.options[index]?.value !== option.id || this.picker.options[index]?.textContent !== option.label)) {
      this.picker.replaceChildren(...options.map((item) => {
        const option = create('option', '', item.label);
        option.value = item.id;
        return option;
      }));
    }
    this.picker.value = this.profileId ?? '';
    const profile = this.state.profiles.find((entry) => entry.id === this.profileId);
    this.summary.replaceChildren(...(profile
      ? [profileBadge(profile.name, profile.color), create('span', '', COLORS[profile.color]), create('code', '', profile.id)]
      : [create('span', '', '一覧は全プロファイルを対象にします。履歴設定・一括削除では、個別のプロファイルを選んでください。')]));
    this.heading.textContent = this.kind === 'bookmarks' ? 'ブックマーク' : '閲覧履歴';
    this.add.hidden = this.kind !== 'bookmarks';
    this.back.hidden = !this.state.activeTabId;
  }

  private syncState(): void {
    this.stateError.textContent = this.state.data.error ?? '';
    this.stateError.hidden = !this.state.data.error;
  }

  private clearInputs(): void {
    this.search.value = '';
    if (this.editor) {
      this.editor.title.value = '';
      this.editor.url.value = '';
    }
  }

  private clearEditor(): void {
    if (this.editor) {
      this.editor.title.value = '';
      this.editor.url.value = '';
    }
    this.editor = null;
    this.editorRegion.replaceChildren();
    this.editorRegion.hidden = true;
  }

  private resetPagination(): void {
    this.cursors = [null];
    this.pageIndex = 0;
  }

  private resetContext(): void {
    this.context++;
    this.inputGeneration++;
    this.queryGeneration++;
    this.pending = null;
    this.loading = false;
    this.clearInputs();
    this.clearEditor();
    this.page = null;
    this.query = '';
    this.resetPagination();
    this.results.replaceChildren();
    this.setFeedback('');
  }

  private async loadPage(): Promise<void> {
    if (!this.active()) return;
    const generation = ++this.queryGeneration;
    const context = this.context;
    this.loading = true;
    this.page = null;
    this.queryError.textContent = '';
    this.queryError.hidden = true;
    this.count.textContent = '一覧を取得しています…';
    this.results.replaceChildren();
    this.renderPreferences();
    this.syncControls();
    try {
      const result = await window.shinano.library.query({
        kind: this.kind, profileId: this.profileId, query: this.query,
        cursor: this.cursors[this.pageIndex] ?? null,
      });
      if (!this.active() || context !== this.context || generation !== this.queryGeneration) return;
      if (!result.ok) {
        this.queryError.textContent = result.error;
        this.queryError.hidden = false;
        this.count.textContent = '一覧を取得できませんでした。検索条件を確認するか「一覧を再取得」を押してください。';
        return;
      }
      this.page = result.value;
      this.renderResults();
    } catch {
      if (!this.active() || context !== this.context || generation !== this.queryGeneration) return;
      this.queryError.textContent = TRANSPORT_ERROR;
      this.queryError.hidden = false;
      this.count.textContent = '一覧を取得できませんでした。表示件数は未確認です。';
    } finally {
      if (this.active() && context === this.context && generation === this.queryGeneration) {
        this.loading = false;
        this.renderPreferences();
        this.syncControls();
      }
    }
  }

  private renderPreferences(): void {
    this.preferences.replaceChildren();
    this.preferences.hidden = this.kind !== 'history';
    if (this.kind !== 'history') return;
    this.preferences.append(create('h2', '', 'この端末の履歴の記録方法'),
      create('p', 'description',
        `既定は「詳細」です。ページのパスと実際のタイトルを ${HISTORY_DAYS} 日間記録します。クエリとフラグメントは記録しません。`
        + 'パスやタイトルにも秘密が含まれる場合があり、完全には検出できません。'
        + 'クエリ・フラグメントが必要なページは履歴から正確に再表示できず、オリジンのみの記録ではパスも復元できません。'));
    if (!this.profileId) {
      this.preferences.append(create('p', 'field-hint', '記録方法の変更・履歴の一括削除は、上でプロファイルを選んでから行ってください。'));
      return;
    }
    const mode = create('select');
    mode.id = 'history-mode';
    const labels: { value: HistoryMode; label: string }[] = [
      { value: 'detailed', label: '詳細（既定）: パスと実際のタイトル' },
      { value: 'origins', label: 'オリジンのみ: 接続先とホスト名' },
      { value: 'off', label: '記録しない' },
    ];
    if (this.page?.historyMode === null || !this.page) {
      const unknown = create('option', '', '現在の設定は未確認です');
      unknown.value = '';
      mode.append(unknown);
    }
    for (const label of labels) {
      const option = create('option', '', label.label);
      option.value = label.value;
      mode.append(option);
    }
    mode.value = this.page?.historyMode ?? '';
    const profileId = this.profileId;
    mode.addEventListener('change', (event) => {
      event.stopPropagation();
      const value = mode.value;
      if (value !== 'detailed' && value !== 'origins' && value !== 'off') return;
      void this.mutate({ type: 'history:mode', profileId, mode: value }, '記録方法を変更しました。既存の履歴は変更していません。');
    });
    this.preferences.append(create('label', 'data-field history-mode-label', '記録方法', mode),
      create('p', 'field-hint',
        '「記録しない」は今後の記録を止めます。既存・取り込み済みの履歴は消去せず、同期の対象設定も変えません。'
        + '必要なら履歴の削除と「同期」画面での履歴連携の解除を別々に行ってください。'),
      create('div', 'data-actions',
        this.button('history-off', '今後の履歴を記録しない', 'secondary-button',
          () => this.mutate({ type: 'history:mode', profileId, mode: 'off' }, '今後の履歴の記録を停止しました。既存の履歴は残っています。')),
        this.button('history-clear-local', 'この端末の履歴をすべて削除', 'danger-button',
          () => this.mutate({ type: 'history:clear', profileId, scope: 'local' }, 'この端末の対象プロファイルの履歴を削除しました。')),
        this.button('history-clear-vault', '共有保管庫の履歴をすべて削除', 'danger-button',
          () => this.mutate({ type: 'history:clear', profileId, scope: 'vault' }, '共有保管庫の履歴削除を記録しました。クラウド配信の確認ではありません。'), true)));
  }

  private renderResults(): void {
    const page = this.page;
    if (!page) return;
    const offset = this.cursors[this.pageIndex]?.offset ?? 0;
    this.count.textContent = page.entries.length
      ? `${page.total} 件中 ${offset + 1}–${offset + page.entries.length} 件 · 1 ページ最大 ${LIBRARY_PAGE_SIZE} 件`
      : `検索結果 0 件 · 全 ${page.total} 件`;
    this.results.replaceChildren();
    if (!page.entries.length) {
      this.results.append(create('p', 'empty-state', 'この条件に一致する記録はありません。'));
      return;
    }
    for (const entry of page.entries) {
      const profile = this.state.profiles.find((item) => item.id === entry.profileId);
      const card = create('article', 'card library-entry',
        create('div', 'data-profile-summary', profileBadge(profile?.name ?? '未導入のプロファイル', profile?.color ?? 'slate'),
          create('code', '', entry.profileId),
          create('time', '', new Date(entry.at).toLocaleString('ja-JP'))));
      card.dataset.recordId = entry.id;
      const conflict = entry.versions.length > 1;
      if (conflict) {
        card.append(create('h2', '', `競合する ${entry.versions.length} 件の版`),
          create('p', 'field-hint', this.kind === 'bookmarks'
            ? '自動では版を選びません。内容を比較し、採用する版を選んで編集・保存してください。'
            : '自動では版を選びません。各版の内容を確認してください。履歴の内容は編集できません。'));
        for (const version of entry.versions) card.append(this.version(entry, version, true));
      } else {
        card.append(this.version(entry, { revision: entry.revision, title: entry.title, url: entry.url }, false));
      }
      const kind = this.kind;
      card.append(create('div', 'data-actions library-removal',
        this.button(`library-remove-local-${entry.id}`, 'この端末から削除', 'danger-button',
          () => this.mutate({ type: 'entry:remove', kind, profileId: entry.profileId, recordId: entry.id, scope: 'local' },
            'この端末の表示から削除しました。共有保管庫の記録は削除していません。')),
        this.button(`library-remove-vault-${entry.id}`, '共有保管庫から削除', 'danger-button',
          () => this.mutate({ type: 'entry:remove', kind, profileId: entry.profileId, recordId: entry.id, scope: 'vault' },
            '共有保管庫の削除を記録しました。クラウドの版履歴の消去や配信完了の確認ではありません。'), true)));
      this.results.append(card);
    }
    this.syncControls();
  }

  private version(entry: LibraryEntry, version: LibraryVersion, conflict: boolean): HTMLElement {
    const kind = this.kind;
    const section = create('section', conflict ? 'library-version data-conflict' : 'library-version',
      create('h3', 'library-title', version.title || 'タイトルなし'),
      create('p', 'library-url', version.url));
    if (conflict) section.append(create('p', 'field-hint', `版: ${version.revision}`));
    const actions = create('div', 'data-actions',
      this.button(`library-open-${entry.id}-${version.revision}`, 'このプロファイルで開く', 'secondary-button',
        () => this.mutate({ type: 'entry:open', kind, profileId: entry.profileId, recordId: entry.id, revision: version.revision }, '')));
    if (kind === 'bookmarks') {
      actions.append(this.button(`library-edit-${entry.id}-${version.revision}`, conflict ? 'この版を選んで編集・解決' : '編集',
        'secondary-button', () => this.openEditor(entry.profileId, entry.id, entry.versions.map((item) => item.revision),
          version.title, version.url)));
    }
    section.append(actions);
    return section;
  }

  private openEditor(profileId: string, recordId: string | null, parents: string[], titleValue: string, urlValue: string): void {
    if (!this.active() || this.pending || this.kind !== 'bookmarks') return;
    this.clearEditor();
    const title = create('input');
    title.id = 'bookmark-title';
    title.maxLength = MAX_LIBRARY_TITLE;
    title.autocomplete = 'off';
    title.spellcheck = false;
    title.value = titleValue;
    const url = create('input');
    url.id = 'bookmark-url';
    url.type = 'url';
    url.maxLength = MAX_LIBRARY_URL;
    url.autocomplete = 'off';
    url.autocapitalize = 'off';
    url.spellcheck = false;
    url.required = true;
    url.value = urlValue;
    const profile = this.state.profiles.find((item) => item.id === profileId);
    const save = submitButton(parents.length > 1 ? '全競合版を解決して保存' : '保存');
    save.id = 'bookmark-save';
    const form = create('form', 'data-form',
      create('label', 'data-field', 'タイトル', title),
      create('label', 'data-field', '完全な URL', url),
      create('p', 'info-box',
        '明示的に保存する URL にはパス・クエリ・フラグメントが残ります。必要な値を勝手に削除しません。'
        + '認証情報や秘密の共有リンクが含まれていないか、完全な URL とタイトルを確認してください。'
        + '連携中のプロファイルでは共有保管庫にも送られます。機密性の高い URL や共有の確認は保存時に別画面で行います。'),
      create('div', 'data-actions', save,
        this.button('bookmark-cancel', 'キャンセル', 'secondary-button', () => {
          this.inputGeneration++;
          this.clearEditor();
          this.setFeedback('編集をキャンセルしました。保存していません。');
        })));
    form.id = 'bookmark-form';
    form.autocomplete = 'off';
    this.editor = { form, profileId, recordId, parents, title, url };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.editor?.form !== form) return;
      const editor = this.editor;
      let titleInput = editor.title.value;
      let urlInput = editor.url.value;
      editor.title.value = '';
      editor.url.value = '';
      const response = this.mutate({
        type: 'bookmark:save', profileId: editor.profileId, recordId: editor.recordId,
        parents: [...editor.parents], title: titleInput, url: urlInput,
      }, 'ブックマークをローカルに保存しました。共有先への配信完了を示すものではありません。');
      titleInput = '';
      urlInput = '';
      void response;
    });
    this.editorRegion.append(create('h2', '', recordId ? 'ブックマークを編集' : '現在のページをブックマークに追加'),
      create('div', 'data-profile-summary', profileBadge(profile?.name ?? '未導入', profile?.color ?? 'slate'), create('code', '', profileId)),
      form);
    this.editorRegion.hidden = false;
    this.editorRegion.scrollIntoView({ block: 'nearest' });
    this.syncControls();
    title.focus();
  }

  private async captureCurrent(): Promise<void> {
    const context = this.context;
    const inputGeneration = this.inputGeneration;
    const action = {};
    this.pending = action;
    this.clearEditor();
    this.setFeedback('現在のページの確定済み URL を取得しています…');
    this.syncControls();
    try {
      const result = await window.shinano.library.currentBookmark();
      if (!this.active() || context !== this.context || inputGeneration !== this.inputGeneration || this.pending !== action) return;
      if (!result.ok) {
        this.reportError(result.error);
        return;
      }
      if (!this.state.profiles.some((profile) => profile.id === result.value.profileId)) {
        this.reportError('保存先のプロファイルが変わりました。現在のページから追加をやり直してください。');
        return;
      }
      this.pending = null;
      if (this.profileId !== result.value.profileId) {
        this.resetContext();
        this.profileId = result.value.profileId;
        this.syncProfile();
        void this.loadPage();
      }
      this.setFeedback('保存先と完全な URL を確認して「保存」を押してください。まだ保存していません。');
      this.openEditor(result.value.profileId, null, [], result.value.title, result.value.url);
    } catch {
      if (this.active() && context === this.context && inputGeneration === this.inputGeneration) this.reportError(TRANSPORT_ERROR);
    } finally {
      if (this.pending === action) {
        this.pending = null;
        if (this.active() && inputGeneration !== this.inputGeneration) this.setFeedback('画面を離れたため、追加を中止しました。もう一度追加してください。');
        this.syncControls();
      }
    }
  }

  private async mutate(command: LibraryCommand, message: string): Promise<void> {
    if (!this.active() || this.pending) return;
    const action = {};
    const context = this.context;
    this.pending = action;
    this.setFeedback('対象と操作範囲を確認しています…');
    this.syncControls();
    try {
      const result = await window.shinano.library.command(command);
      if (!this.active() || context !== this.context || this.pending !== action) return;
      if (!result.ok) {
        this.reportError(result.error);
        return;
      }
      if (result.value.outcome === 'cancelled') {
        this.setFeedback('操作をキャンセルしました。');
        return;
      }
      const expected = command.type === 'entry:open' ? 'opened' : command.type === 'bookmark:save' ? 'saved'
        : command.type === 'history:mode' ? 'updated' : 'removed';
      if (result.value.outcome !== expected) {
        this.reportError('操作結果を確認できませんでした。一覧を再取得して状態を確認してください。');
        return;
      }
      if (command.type === 'bookmark:save') this.clearEditor();
      this.setFeedback(message);
      if (command.type === 'entry:open') await this.close();
      else {
        this.resetPagination();
        await this.loadPage();
      }
    } catch {
      if (this.active() && context === this.context && this.pending === action) this.reportError(TRANSPORT_ERROR);
    } finally {
      if (this.pending === action) {
        this.pending = null;
        this.syncControls();
      }
    }
  }

  private syncControls(): void {
    const busy = this.pending !== null;
    for (const control of this.surface.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) {
      control.disabled = busy;
    }
    for (const button of this.surface.querySelectorAll<HTMLButtonElement>('button[data-vault-action]')) {
      button.disabled = busy || this.state.data.syncPhase !== 'ready';
    }
    this.previous.disabled = busy || this.loading || !this.page || this.pageIndex === 0;
    this.next.disabled = busy || this.loading || !this.page?.next;
    this.add.disabled = busy || !this.state.activeTabId;
    this.back.disabled = false;
    this.surface.setAttribute('aria-busy', String(busy || this.loading));
    this.results.setAttribute('aria-busy', String(this.loading));
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
    this.resetContext();
    try {
      if (!await this.callbacks.close() && this.active()) {
        this.reportError('タブに戻れませんでした。もう一度お試しください。');
        await this.loadPage();
      }
    } catch {
      if (this.active()) this.reportError(TRANSPORT_ERROR);
    }
  }
}
