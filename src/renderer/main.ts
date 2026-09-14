import './style.css';
import {
  CHROME_HEIGHT, PROFILE_COLORS, SERVICES,
  type BrowserState, type Command, type ProfileColor, type Tab,
} from '../shared/model.ts';

const colorNames: Record<ProfileColor, string> = {
  blue: 'ブルー', teal: 'ティール', purple: 'パープル', orange: 'オレンジ', rose: 'ローズ', slate: 'グレー',
};
const downloadStatus = {
  progressing: 'ダウンロード中', completed: '完了', cancelled: 'キャンセル', interrupted: '中断',
};

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error('Application UI is incomplete.');
  return found;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

const chrome = element('#chrome');
const tabs = element('#tabs');
const workspace = element('#workspace');
const address = element<HTMLInputElement>('#address');
const status = element('#status');
const back = element<HTMLButtonElement>('#back');
const forward = element<HTMLButtonElement>('#forward');
const reload = element<HTMLButtonElement>('#reload');
const activeProfile = element('#active-profile');
const connection = element('#connection');
const dismissNotice = element<HTMLButtonElement>('#dismiss-notice');
document.documentElement.style.setProperty('--chrome-height', `${CHROME_HEIGHT}px`);

let state: BrowserState | undefined;
let surfaceKey = '';
let selectedProfileId = '';
let pendingUrl = '';
let localError: string | null = null;
let addressDirty = false;
let addressEditRevision = 0;

function activeTab(): Tab | undefined {
  return state?.tabs.find((tab) => tab.id === state?.activeTabId);
}

function syncAddress(): void {
  const active = activeTab();
  address.value = active?.url === 'about:blank' ? '' : active?.url ?? '';
}

async function dispatch(command: Command): Promise<boolean> {
  localError = null;
  try {
    const result = await window.shinano.dispatch(command);
    if (!result.ok) {
      localError = result.error;
      renderStatus();
      return false;
    }
    update(result.value);
    return true;
  } catch {
    localError = 'アプリとの通信に失敗しました。Shinano を再起動してください。';
    renderStatus();
    return false;
  }
}

function update(next: BrowserState): void {
  if (state && next.revision < state.revision) return;
  const previousActive = state?.activeTabId;
  state = next;
  if (!state.profiles.some((profile) => profile.id === selectedProfileId)) selectedProfileId = '';
  const active = activeTab();
  const scroll = tabs.scrollLeft;
  tabs.innerHTML = state.tabs.map((tab) => {
    const profile = state?.profiles.find((entry) => entry.id === tab.profileId);
    if (!profile) return '';
    return `<div class="tab ${tab.id === state?.activeTabId ? 'active' : ''}" data-color="${profile.color}" data-tab-id="${tab.id}">
      <button class="tab-select" role="tab" aria-selected="${tab.id === state?.activeTabId}" data-action="activate" data-id="${tab.id}" title="${escape(profile.name)} | ${escape(tab.title)}">
        <span class="profile-badge" data-color="${profile.color}">${escape(profile.name)}</span>
        <span class="tab-title">${tab.loading ? '<span class="spinner" aria-label="読み込み中"></span>' : ''}${escape(tab.title)}</span>
      </button>
      <button class="tab-close" data-action="close" data-id="${tab.id}" aria-label="${escape(profile.name)} | ${escape(tab.title)} を閉じる">×</button>
    </div>`;
  }).join('');
  tabs.scrollLeft = scroll;
  if (previousActive !== state.activeTabId) {
    tabs.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  if (!addressDirty || document.activeElement !== address || previousActive !== state.activeTabId) {
    addressDirty = false;
    syncAddress();
  }
  back.disabled = !active?.canGoBack;
  forward.disabled = !active?.canGoForward;
  reload.disabled = !active || active.isStartPage;
  reload.textContent = active?.loading ? '×' : '↻';
  reload.setAttribute('aria-label', active?.loading ? '読み込みを停止' : '再読み込み');
  const profile = state.profiles.find((entry) => entry.id === active?.profileId);
  activeProfile.textContent = profile?.name ?? '未選択';
  activeProfile.dataset.color = profile?.color ?? 'slate';
  connection.textContent = active?.url.startsWith('https:') ? 'HTTPS' : active?.url.startsWith('http:') ? 'HTTP' : '—';
  connection.dataset.insecure = String(active?.url.startsWith('http:') ?? false);
  renderStatus();
  renderSurface();
}

function renderStatus(): void {
  const active = activeTab();
  const message = localError ?? state?.notice ?? active?.error;
  status.textContent = message ?? (active?.loading
    ? 'ページを読み込んでいます…'
    : 'プロファイル名はローカルのラベルです。サイトのログイン ID を保証するものではありません。');
  status.title = status.textContent;
  chrome.classList.toggle('has-notice', Boolean(message));
  dismissNotice.hidden = !localError && !state?.notice;
}

function colorOptions(selected: ProfileColor = 'blue'): string {
  return PROFILE_COLORS.map((color) => `<option value="${color}" ${color === selected ? 'selected' : ''}>${colorNames[color]}</option>`).join('');
}

function profileOptions(): string {
  return `<option value="">使用するプロファイルを選択</option>${state?.profiles.map((profile) =>
    `<option value="${profile.id}" ${profile.id === selectedProfileId ? 'selected' : ''}>${escape(profile.name)} · ${profile.id.slice(0, 8)}</option>`).join('') ?? ''}`;
}

function heading(eyebrow: string, title: string, description: string): string {
  return `<div class="surface-heading">
    <div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="description">${description}</p></div>
    ${state?.activeTabId ? '<button data-action="browser" class="secondary-button">タブに戻る</button>' : ''}
  </div>`;
}

function renderSurface(): void {
  if (!state) return;
  const currentState = state;
  const active = activeTab();
  const surface = state.panel !== 'none' ? state.panel
    : active?.error ? 'error' : !active || active.isStartPage ? 'new-tab' : 'remote';
  const nextKey = JSON.stringify({
    surface,
    profiles: state.profiles,
    error: surface === 'error' ? { id: active?.id, message: active?.error } : null,
    downloads: surface === 'downloads' ? state.downloads : null,
    hasActive: Boolean(state.activeTabId),
  });
  if (surfaceKey === nextKey) return;
  surfaceKey = nextKey;
  workspace.dataset.surface = surface;
  workspace.setAttribute('aria-label', surface === 'remote' ? 'Web ページ' : 'Shinano の操作画面');
  if (surface === 'remote') {
    workspace.innerHTML = '';
    return;
  }
  if (surface === 'profiles') {
    workspace.innerHTML = `<div class="surface">
      ${heading('LOCAL PROFILES', 'プロファイル', 'ひとつのプロファイルに、ひとつのブラウザーセッション。タブを切り替えても割り当ては変わりません。')}
      <div class="info-box">ここで管理するのは Shinano のローカルデータだけです。クラウドのアカウントや Edge / Chrome のプロファイルは変更しません。</div>
      <section class="card create-profile">
        <h2>プロファイルを作成</h2>
        <form id="create-profile-form" class="profile-form">
          <label class="grow">表示名<input name="name" aria-label="新しいプロファイル名" maxlength="40" placeholder="例: 営業担当、IT 管理者" required /></label>
          <label>色<select name="color" aria-label="新しいプロファイルの色">${colorOptions()}</select></label>
          <button class="primary-button" type="submit">作成</button>
        </form>
      </section>
      <div class="section-label">保存済み ${state.profiles.length} / 20</div>
      <div class="profile-list">${state.profiles.map((profile) => `<section class="card profile-card" data-color="${profile.color}">
        <span class="profile-dot" data-color="${profile.color}" aria-hidden="true"></span>
        <form class="profile-form grow" data-edit-profile="${profile.id}">
          <label class="grow">表示名<input name="name" aria-label="${escape(profile.name)} の表示名" value="${escape(profile.name)}" maxlength="40" required /></label>
          <label>色<select name="color" aria-label="${escape(profile.name)} の色">${colorOptions(profile.color)}</select></label>
          <button class="secondary-button" type="submit">保存</button>
          <button class="danger-button" type="button" data-action="delete-profile" data-id="${profile.id}">削除</button>
        </form>
        <small class="profile-detail">${currentState.tabs.filter((tab) => tab.profileId === profile.id).length} タブ · ${profile.id.slice(0, 8)}</small>
      </section>`).join('') || '<p class="empty-state">プロファイルがありません。上のフォームから作成してください。</p>'}</div>
      <p class="footnote">表示名と色はメタデータです。パスワード・トークンを名前として入力しないでください。</p>
    </div>`;
    return;
  }
  if (surface === 'downloads') {
    workspace.innerHTML = `<div class="surface">
      ${heading('DOWNLOADS', 'ダウンロード', '保存先を確認したファイルだけを保存します。ファイルを自動で開くことはありません。')}
      <div class="card download-list">${state.downloads.map((download) => {
        const profile = state?.profiles.find((entry) => entry.id === download.profileId);
        const size = (bytes: number) => `${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;
        return `<div class="download">
          <span class="profile-badge" data-color="${profile?.color ?? 'slate'}">${escape(profile?.name ?? '削除済み')}</span>
          <div class="grow"><strong>${escape(download.fileName)}</strong><p>${downloadStatus[download.status]} · ${size(download.receivedBytes)}${download.totalBytes ? ` / ${size(download.totalBytes)}` : ''}</p></div>
        </div>`;
      }).join('') || '<p class="empty-state">この起動中のダウンロードはありません。</p>'}</div>
      <p class="footnote">直近 30 件の表示のみです。履歴の復元や中断ファイルの再開には対応していません。保存済みファイルはプロファイル削除後も残ります。</p>
    </div>`;
    return;
  }
  if (surface === 'error') {
    workspace.innerHTML = `<div class="surface error-surface">
      <p class="eyebrow">PAGE UNAVAILABLE</p><h1>ページを開けませんでした</h1>
      <p class="description">${escape(active?.error ?? '')}</p>
      <button class="primary-button" data-action="retry" data-id="${active?.id ?? ''}">再読み込み</button>
      <p class="footnote">証明書エラー、条件付きアクセス、MFA を回避する機能はありません。</p>
    </div>`;
    return;
  }
  workspace.innerHTML = `<div class="surface start-surface">
    ${heading('YOUR DEMO WORKSPACE', '役割をひとつのウィンドウに。', 'プロファイルを選び、タブを開く。同じプロファイルの Cookie・サイトデータは共有され、異なるプロファイルとは分離されます。')}
    <section class="card launch-card">
      <div class="launch-step"><span class="step-number">1</span><h2>このタブのプロファイル</h2><button data-action="profiles" class="text-button">管理・作成</button></div>
      <label class="profile-picker-label"><span class="sr-only">タブのプロファイル</span><select id="profile-picker" aria-label="タブのプロファイル" required ${state.profiles.length ? '' : 'disabled'}>${profileOptions()}</select></label>
      <p class="field-hint">${state.profiles.length ? 'Web サイトにサインインするアカウントは、ページ上で別途確認してください。' : '最初に「管理・作成」からプロファイルを作成してください。'}</p>
      <div class="launch-step second-step"><span class="step-number">2</span><h2>接続先を選択</h2></div>
      <form id="new-tab-form" class="new-tab-form">
        <input id="new-url" name="url" type="text" aria-label="新しいタブの URL" placeholder="https://example.com または localhost:3000" value="${escape(pendingUrl)}" autocomplete="off" spellcheck="false" />
        <button class="primary-button" type="submit">タブを開く</button>
      </form>
      <button class="text-button blank-tab" data-action="blank-tab">空のタブを開く</button>
    </section>
    <div class="section-heading"><h2>Microsoft 365</h2><span>Web サービスのショートカット</span></div>
    <div class="service-grid">${SERVICES.map((service, index) => `<button class="service-card" data-action="service" data-service="${index}">
      <span class="service-mark service-${index}" aria-hidden="true">${service.mark}</span>
      <span><strong>${service.name}</strong><small>${service.description}</small></span><span class="service-arrow" aria-hidden="true">↗</span>
    </button>`).join('')}</div>
    <div class="info-box quiet">ショートカットはサインインやライセンスを付与しません。MFA・条件付きアクセスはそのまま適用されます。実 Microsoft 365 認証と Teams のメディア機能は、この版では動作保証していません。</div>
    <p class="footnote">再起動時はタブのプロファイルとオリジンを復元します。機密情報が含まれ得る URL のパス・クエリ・フラグメントは保存しません。</p>
  </div>`;
}

async function createTab(url: string): Promise<void> {
  if (!selectedProfileId) {
    localError = 'このタブで使用するプロファイルを選択してください。';
    renderStatus();
    document.querySelector<HTMLSelectElement>('#profile-picker')?.focus();
    return;
  }
  if (await dispatch({ type: 'tab:create', profileId: selectedProfileId, url })) {
    pendingUrl = '';
  }
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  switch (button.dataset.action) {
    case 'activate': if (id) void dispatch({ type: 'tab:activate', tabId: id }); break;
    case 'close': if (id) void dispatch({ type: 'tab:close', tabId: id }); break;
    case 'retry': if (id) void dispatch({ type: 'tab:reload', tabId: id }); break;
    case 'delete-profile': if (id) void dispatch({ type: 'profile:delete', profileId: id }); break;
    case 'profiles': void dispatch({ type: 'ui:panel', panel: 'profiles' }); break;
    case 'downloads': void dispatch({ type: 'ui:panel', panel: 'downloads' }); break;
    case 'browser': void dispatch({ type: 'ui:panel', panel: 'none' }); break;
    case 'new-tab': void dispatch({ type: 'ui:panel', panel: 'new-tab' }); break;
    case 'blank-tab': void createTab('about:blank'); break;
    case 'service': {
      const service = SERVICES[Number(button.dataset.service)];
      if (service) void createTab(service.url);
      break;
    }
  }
});

document.addEventListener('change', (event) => {
  if (event.target instanceof HTMLSelectElement && event.target.id === 'profile-picker') {
    selectedProfileId = event.target.value;
  }
});

document.addEventListener('submit', (event) => {
  if (!(event.target instanceof HTMLFormElement)) return;
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  if (form.id === 'address-form') {
    const active = activeTab();
    if (active) {
      const editRevision = addressEditRevision;
      void dispatch({ type: 'tab:navigate', tabId: active.id, input: address.value }).then((success) => {
        if (success && editRevision === addressEditRevision && activeTab()?.id === active.id) {
          addressDirty = false;
          address.blur();
          syncAddress();
        }
      });
    }
    else {
      pendingUrl = address.value;
      surfaceKey = '';
      void dispatch({ type: 'ui:panel', panel: 'new-tab' });
    }
  } else if (form.id === 'new-tab-form') {
    void createTab(String(data.get('url') ?? ''));
  } else if (form.id === 'create-profile-form' || form.dataset.editProfile) {
    const color = data.get('color');
    if (!PROFILE_COLORS.some((entry) => entry === color)) {
      localError = 'プロファイルの色を選択してください。';
      renderStatus();
      return;
    }
    const fields = { name: String(data.get('name') ?? ''), color: color as ProfileColor };
    void dispatch(form.dataset.editProfile
      ? { type: 'profile:update', profileId: form.dataset.editProfile, ...fields }
      : { type: 'profile:create', ...fields });
  }
});

back.addEventListener('click', () => {
  const active = activeTab();
  if (active) void dispatch({ type: 'tab:back', tabId: active.id });
});
address.addEventListener('input', () => {
  addressDirty = true;
  addressEditRevision++;
});
address.addEventListener('blur', () => {
  addressDirty = false;
  syncAddress();
});
forward.addEventListener('click', () => {
  const active = activeTab();
  if (active) void dispatch({ type: 'tab:forward', tabId: active.id });
});
reload.addEventListener('click', () => {
  const active = activeTab();
  if (active) void dispatch({ type: active.loading ? 'tab:stop' : 'tab:reload', tabId: active.id });
});
dismissNotice.addEventListener('click', () => {
  localError = null;
  void dispatch({ type: 'ui:dismiss-notice' });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state?.panel !== 'none') {
    void dispatch({ type: 'ui:panel', panel: 'none' });
  }
});

if (window.shinano) {
  window.shinano.onState(update);
  window.shinano.onFocusAddress(() => {
    address.focus();
    address.select();
  });
  void window.shinano.getState().then((result) => {
    if (result.ok) update(result.value);
    else {
      localError = result.error;
      renderStatus();
    }
  }).catch(() => {
    localError = 'アプリの初期状態を取得できませんでした。Shinano を再起動してください。';
    renderStatus();
  });
} else {
  status.textContent = '操作用 API を読み込めませんでした。ビルド結果を確認して Shinano を再起動してください。';
}
