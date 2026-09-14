import './style.css';
import { actionButton, create, element, profileBadge, submitButton } from './dom.ts';
import { TotpPanel } from './totp-panel.ts';
import {
  CHROME_HEIGHT, PROFILE_COLORS, SERVICES,
  type BrowserState, type Command, type Profile, type ProfileColor, type Tab,
} from '../shared/model.ts';

const colorNames: Record<ProfileColor, string> = {
  blue: 'ブルー', teal: 'ティール', purple: 'パープル', orange: 'オレンジ', rose: 'ローズ', slate: 'グレー',
};
const downloadStatus = {
  progressing: 'ダウンロード中', completed: '完了', cancelled: 'キャンセル', interrupted: '中断',
};

function tabElement(tab: Tab, profile: Profile, isActive: boolean): HTMLDivElement {
  const title = create('span', 'tab-title', tab.title);
  if (tab.loading) {
    const spinner = create('span', 'spinner');
    spinner.setAttribute('aria-label', '読み込み中');
    title.prepend(spinner);
  }
  const select = actionButton('', 'tab-select', 'activate', tab.id);
  select.setAttribute('role', 'tab');
  select.setAttribute('aria-selected', String(isActive));
  select.title = `${profile.name} | ${tab.title}`;
  select.append(profileBadge(profile.name, profile.color), ' ', title);
  const close = actionButton('×', 'tab-close', 'close', tab.id);
  close.setAttribute('aria-label', `${profile.name} | ${tab.title} を閉じる`);
  const node = create('div', isActive ? 'tab active' : 'tab', select, close);
  node.dataset.color = profile.color;
  node.dataset.tabId = tab.id;
  return node;
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
let totpPanel: TotpPanel | undefined;

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
  tabs.replaceChildren(...next.tabs.flatMap((tab) => {
    const profile = next.profiles.find((entry) => entry.id === tab.profileId);
    return profile ? [tabElement(tab, profile, tab.id === next.activeTabId)] : [];
  }));
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

function option(value: string, label: string, selected = false): HTMLOptionElement {
  const node = create('option', '', label);
  node.value = value;
  node.defaultSelected = selected;
  node.selected = selected;
  return node;
}

function colorOptions(selected: ProfileColor = 'blue'): HTMLOptionElement[] {
  return PROFILE_COLORS.map((color) => option(color, colorNames[color], color === selected));
}

function profileOptions(profiles: Profile[]): HTMLOptionElement[] {
  return [
    option('', '使用するプロファイルを選択', !selectedProfileId),
    ...profiles.map((profile) =>
      option(profile.id, `${profile.name} · ${profile.id.slice(0, 8)}`, profile.id === selectedProfileId)),
  ];
}

function heading(eyebrow: string, title: string, description: string): HTMLDivElement {
  const node = create('div', 'surface-heading',
    create('div', '', create('p', 'eyebrow', eyebrow), create('h1', '', title), create('p', 'description', description)));
  if (state?.activeTabId) node.append(actionButton('タブに戻る', 'secondary-button', 'browser'));
  return node;
}

function profileForm(profile?: Profile): HTMLFormElement {
  const name = create('input');
  name.name = 'name';
  name.maxLength = 40;
  name.required = true;
  name.setAttribute('aria-label', profile ? `${profile.name} の表示名` : '新しいプロファイル名');
  if (profile) name.value = profile.name;
  else name.placeholder = '例: 営業担当、IT 管理者';
  const color = create('select', '', ...colorOptions(profile?.color));
  color.name = 'color';
  color.setAttribute('aria-label', profile ? `${profile.name} の色` : '新しいプロファイルの色');
  const form = create('form', profile ? 'profile-form grow' : 'profile-form',
    create('label', 'grow', '表示名', name),
    create('label', '', '色', color),
    submitButton(profile ? '保存' : '作成', profile ? 'secondary-button' : 'primary-button'));
  if (profile) {
    form.dataset.editProfile = profile.id;
    form.append(actionButton('削除', 'danger-button', 'delete-profile', profile.id));
  } else {
    form.id = 'create-profile-form';
  }
  return form;
}

function renderSurface(): void {
  if (!state) return;
  const currentState = state;
  const active = activeTab();
  const surface = state.panel !== 'none' ? state.panel
    : active?.error ? 'error' : !active || active.isStartPage ? 'new-tab' : 'remote';
  if (surface === 'totp') {
    surfaceKey = 'totp';
    workspace.dataset.surface = 'totp';
    workspace.setAttribute('aria-label', 'Shinano の認証コード画面');
    if (totpPanel) totpPanel.update(currentState);
    else {
      totpPanel = new TotpPanel(workspace, currentState, {
        selectProfile: (profileId) => dispatch({ type: 'ui:totp-profile', profileId }),
        close: () => dispatch({ type: 'ui:panel', panel: 'none' }),
        reportError: (message) => {
          localError = message;
          renderStatus();
        },
      });
    }
    return;
  }
  totpPanel?.dispose();
  totpPanel = undefined;
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
    workspace.replaceChildren();
    return;
  }
  if (surface === 'profiles') {
    const list = create('div', 'profile-list');
    for (const profile of currentState.profiles) {
      const dot = create('span', 'profile-dot');
      dot.dataset.color = profile.color;
      dot.setAttribute('aria-hidden', 'true');
      const detail = `${currentState.tabs.filter((tab) => tab.profileId === profile.id).length} タブ · ${profile.id.slice(0, 8)}`;
      const card = create('section', 'card profile-card', dot, profileForm(profile),
        actionButton('認証コード', 'secondary-button', 'totp-profile', profile.id),
        create('small', 'profile-detail', detail));
      card.dataset.color = profile.color;
      list.append(card);
    }
    if (!currentState.profiles.length) {
      list.append(create('p', 'empty-state', 'プロファイルがありません。上のフォームから作成してください。'));
    }
    workspace.replaceChildren(create('div', 'surface',
      heading('LOCAL PROFILES', 'プロファイル', 'ひとつのプロファイルに、ひとつのブラウザーセッション。タブを切り替えても割り当ては変わりません。'),
      create('div', 'info-box', 'ここで管理するのは Shinano のローカルデータだけです。クラウドのアカウントや Edge / Chrome のプロファイルは変更しません。'),
      create('section', 'card create-profile', create('h2', '', 'プロファイルを作成'), profileForm()),
      create('div', 'section-label', `保存済み ${currentState.profiles.length} / 20`),
      list,
      create('p', 'footnote', '表示名と色はメタデータです。パスワード・トークンを名前として入力しないでください。')));
    return;
  }
  if (surface === 'downloads') {
    const list = create('div', 'card download-list');
    const size = (bytes: number) => `${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;
    for (const download of currentState.downloads) {
      const profile = currentState.profiles.find((entry) => entry.id === download.profileId);
      const progress = `${downloadStatus[download.status]} · ${size(download.receivedBytes)}${download.totalBytes ? ` / ${size(download.totalBytes)}` : ''}`;
      list.append(create('div', 'download',
        profileBadge(profile?.name ?? '削除済み', profile?.color ?? 'slate'),
        create('div', 'grow', create('strong', '', download.fileName), create('p', '', progress))));
    }
    if (!currentState.downloads.length) {
      list.append(create('p', 'empty-state', 'この起動中のダウンロードはありません。'));
    }
    workspace.replaceChildren(create('div', 'surface',
      heading('DOWNLOADS', 'ダウンロード', '保存先を確認したファイルだけを保存します。ファイルを自動で開くことはありません。'),
      list,
      create('p', 'footnote', '直近 30 件の表示のみです。履歴の復元や中断ファイルの再開には対応していません。保存済みファイルはプロファイル削除後も残ります。')));
    return;
  }
  if (surface === 'error') {
    workspace.replaceChildren(create('div', 'surface error-surface',
      create('p', 'eyebrow', 'PAGE UNAVAILABLE'),
      create('h1', '', 'ページを開けませんでした'),
      create('p', 'description', active?.error ?? ''),
      actionButton('再読み込み', 'primary-button', 'retry', active?.id ?? ''),
      create('p', 'footnote', '証明書エラー、条件付きアクセス、MFA を回避する機能はありません。')));
    return;
  }
  const picker = create('select', '', ...profileOptions(currentState.profiles));
  picker.id = 'profile-picker';
  picker.required = true;
  picker.disabled = !currentState.profiles.length;
  picker.setAttribute('aria-label', 'タブのプロファイル');
  const url = create('input');
  url.id = 'new-url';
  url.name = 'url';
  url.type = 'text';
  url.setAttribute('aria-label', '新しいタブの URL');
  url.placeholder = 'https://example.com または localhost:3000';
  url.value = pendingUrl;
  url.autocomplete = 'off';
  url.spellcheck = false;
  const form = create('form', 'new-tab-form', url, submitButton('タブを開く'));
  form.id = 'new-tab-form';
  const launch = create('section', 'card launch-card',
    create('div', 'launch-step', create('span', 'step-number', '1'), create('h2', '', 'このタブのプロファイル'),
      actionButton('管理・作成', 'text-button', 'profiles')),
    create('label', 'profile-picker-label', create('span', 'sr-only', 'タブのプロファイル'), picker),
    create('p', 'field-hint', currentState.profiles.length
      ? 'Web サイトにサインインするアカウントは、ページ上で別途確認してください。'
      : '最初に「管理・作成」からプロファイルを作成してください。'),
    create('div', 'launch-step second-step', create('span', 'step-number', '2'), create('h2', '', '接続先を選択')),
    form,
    actionButton('空のタブを開く', 'text-button blank-tab', 'blank-tab'));
  const services = create('div', 'service-grid');
  SERVICES.forEach((service, index) => {
    const mark = create('span', `service-mark service-${index}`, service.mark);
    mark.setAttribute('aria-hidden', 'true');
    const arrow = create('span', 'service-arrow', '↗');
    arrow.setAttribute('aria-hidden', 'true');
    const button = actionButton('', 'service-card', 'service');
    button.dataset.service = String(index);
    button.append(mark, create('span', '', create('strong', '', service.name), create('small', '', service.description)), arrow);
    services.append(button);
  });
  workspace.replaceChildren(create('div', 'surface start-surface',
    heading('YOUR DEMO WORKSPACE', '役割をひとつのウィンドウに。', 'プロファイルを選び、タブを開く。同じプロファイルの Cookie・サイトデータは共有され、異なるプロファイルとは分離されます。'),
    launch,
    create('div', 'section-heading', create('h2', '', 'Microsoft 365'), create('span', '', 'Web サービスのショートカット')),
    services,
    create('div', 'info-box quiet', 'ショートカットはサインインやライセンスを付与しません。MFA・条件付きアクセスはそのまま適用されます。実 Microsoft 365 認証と Teams のメディア機能は、この版では動作保証していません。'),
    create('p', 'footnote', '再起動時はタブのプロファイルとオリジンを復元します。機密情報が含まれ得る URL のパス・クエリ・フラグメントは保存しません。')));
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
    case 'totp': void dispatch({ type: 'ui:panel', panel: 'totp' }); break;
    case 'totp-profile': if (id) void dispatch({ type: 'ui:totp-profile', profileId: id }); break;
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
