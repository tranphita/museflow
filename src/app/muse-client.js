import { state } from '../core/state.js';
import { pinnedMuseTabIds, selectableMuseTabs } from '../core/worker-tabs.js';
import { $, museStatus } from './dom.js';

export const MESSAGE = Object.freeze({
  checkSession: 'MUSETA_CHECK_SESSION',
  diagnose: 'MUSETA_DIAGNOSE',
  generate: 'MUSETA_GENERATE',
  stopGeneration: 'MUSETA_STOP_GENERATION',
});
const MUSE_TAB_URLS = ['https://muse.ai/*', 'https://*.muse.ai/*'];
const BRIDGE_FILES = ['bridge/muse-ui.js', 'bridge/refusal.js', 'bridge/muse-bridge.js'];

const stoppedError = () => new DOMException('Đã dừng tạo theo yêu cầu của bạn.', 'AbortError');

export let preferredMuseTabId = null;

export async function queryMuseTabs() {
  const museTabs = await chrome.tabs.query({ url: MUSE_TAB_URLS });
  if (state.pinnedMuseTabId) return selectableMuseTabs(museTabs, { pinnedId: state.pinnedMuseTabId });
  const pinnedIds = pinnedMuseTabIds(await chrome.tabs.query({}), chrome.runtime.getURL('app.html'));
  return selectableMuseTabs(museTabs, { pinnedIds });
}

export async function museTabMessage(message, preferredTabId, signal, { onlyThisTab = false } = {}) {
  if (signal?.aborted) throw stoppedError();
  const allTabs = await queryMuseTabs();
  const tabs = onlyThisTab ? allTabs.filter(tab => tab.id === preferredTabId) : allTabs;
  if (!tabs.length) throw new Error('Mở Muse.ai và đăng nhập rồi thử lại.');
  const preferred = preferredTabId ?? preferredMuseTabId;
  if (preferred) {
    const index = tabs.findIndex(tab => tab.id === preferred);
    if (index > 0) tabs.unshift(tabs.splice(index, 1)[0]);
  }
  let lastError = '';
  for (const tab of tabs) {
    if (signal?.aborted) throw stoppedError();
    if (!tab.id) continue;
    try {
      const response = await sendMuseTabMessage(tab.id, message, signal);
      if (response === undefined) throw new Error('Cầu nối trang Muse không phản hồi.');
      preferredMuseTabId = tab.id;
      return response;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      lastError = error?.message || String(error);
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: BRIDGE_FILES });
      const response = await sendMuseTabMessage(tab.id, message, signal);
      preferredMuseTabId = tab.id;
      return response;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      lastError = error?.message || String(error);
    }
  }
  throw new Error(
    `Đã thấy tab Muse nhưng Museta không gắn được cầu nối trang: ${lastError || 'lỗi trình duyệt không xác định'}. Kiểm tra quyền truy cập trang Muse trong cài đặt tiện ích của trình duyệt rồi thử lại.`,
  );
}

export function sendMuseTabMessage(tabId, message, signal) {
  if (!signal) return chrome.tabs.sendMessage(tabId, message);
  if (signal.aborted) return Promise.reject(stoppedError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, stoppedError());
    signal.addEventListener('abort', onAbort, { once: true });
    chrome.tabs.sendMessage(tabId, message).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}

export async function sendMuseStop(requestId) {
  try {
    const tabs = await queryMuseTabs();
    const ordered = preferredMuseTabId
      ? tabs.sort((a, b) => (b.id === preferredMuseTabId) - (a.id === preferredMuseTabId))
      : tabs;
    await Promise.allSettled(
      ordered
        .filter(tab => tab.id)
        .map(tab => chrome.tabs.sendMessage(tab.id, { type: MESSAGE.stopGeneration, requestId })),
    );
  } catch {}
}

function renderDiagnostics(checks) {
  const list = $('#museDiagnostics');
  if (!list) return;
  list.replaceChildren();
  list.classList.toggle('hidden', !checks?.length);
  for (const check of checks || []) {
    const item = document.createElement('li');
    item.className = check.ok === null ? 'warn' : check.ok ? 'ok' : 'error';
    item.textContent = `${check.ok === null ? '•' : check.ok ? '✓' : '✗'} ${check.label}`;
    if (check.ok === false) item.title = `Cập nhật bridge/muse-ui.js → ${check.hint}`;
    list.appendChild(item);
  }
}

export async function testMuseSession(preferredTabId) {
  const button = $('#testMuseBtn'),
    status = $('#connectionStatus');
  if (button) button.disabled = true;
  status.className = 'warn';
  status.textContent = 'Đang kiểm tra phiên Muse…';
  try {
    const result = await museTabMessage({ type: MESSAGE.checkSession }, preferredTabId);
    if (!result?.ok) throw new Error(result?.error || 'Kiểm tra phiên Muse thất bại.');
    const diagnostics = await museTabMessage({ type: MESSAGE.diagnose }, preferredMuseTabId).catch(
      () => null,
    );
    renderDiagnostics(diagnostics?.checks);
    const failedHooks = (diagnostics?.checks || []).filter(
      check => check.ok === false && check.id !== 'login',
    );
    const ready = Boolean(result.composer && result.signedIn);
    status.className = ready && !failedHooks.length ? 'ok' : 'warn';
    status.textContent = failedHooks.length
      ? `Trang Muse đã thay đổi: không tìm thấy ${failedHooks.map(check => check.label).join(', ')}. Có thể tạo thất bại cho tới khi cập nhật bridge/muse-ui.js.`
      : ready
        ? 'Đã kết nối phiên Muse.'
        : result.loginRequired
          ? 'Muse yêu cầu đăng nhập. Đăng nhập trên tab Muse rồi kiểm tra lại.'
          : result.composer
            ? 'Khung chat Muse đã sẵn sàng. Chưa xác nhận được trạng thái phiên; vẫn có thể thử tạo.'
            : 'Đã thấy tab Muse nhưng ô nhập tin nhắn chưa sẵn sàng. Mở một cuộc chat Muse rồi thử lại.';
    museStatus.textContent = ready ? '● Phiên Muse sẵn sàng' : '● Phiên Muse cần kiểm tra';
    museStatus.className = ready ? 'ok' : result.loginRequired ? 'warn' : 'ok';
    if (!ready && !result.loginRequired)
      museStatus.textContent = '● Chat Muse sẵn sàng · chưa xác nhận phiên';
    if (failedHooks.length) {
      museStatus.textContent = '● Trang Muse đã thay đổi · mở Cài đặt';
      museStatus.className = 'warn';
    }
    return ready || Boolean(result.composer && !result.loginRequired);
  } catch (error) {
    status.className = 'error';
    status.textContent = error.message;
    renderDiagnostics([]);
    museStatus.textContent = '● Kiểm tra phiên Muse thất bại';
    museStatus.className = 'error';
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

export async function detectMuse() {
  try {
    const tabs = await queryMuseTabs();
    if (tabs.length) {
      const active = tabs.find(t => t.active) || tabs[0];
      await testMuseSession(active.id);
    } else {
      museStatus.textContent = '● Mở muse.ai và đăng nhập';
      museStatus.className = 'warn';
    }
  } catch {
    museStatus.textContent = '● Không kiểm tra được phiên Muse';
    museStatus.className = 'warn';
  }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function prepareMuseTab(tabId, url, { timeoutMs = 90_000 } = {}) {
  const closed = 'Tab Muse của worker này đã bị đóng. Mở Muse.ai và đăng nhập rồi thử lại.';
  if (!(await chrome.tabs.update(tabId, { url }).catch(() => null))) throw new Error(closed);
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await wait(1000);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(closed);
    if (tab.status !== 'complete') continue;
    last = await museTabMessage({ type: MESSAGE.checkSession }, tabId, undefined, {
      onlyThisTab: true,
    }).catch(error => ({ ok: false, error: error?.message || String(error) }));
    if (last?.loginRequired) throw new Error('Muse đã đăng xuất. Mở Muse.ai và đăng nhập rồi thử lại.');
    if (last?.composer) return;
  }
  throw new Error(
    `Khung chat Muse chưa sẵn sàng sau ${Math.round(timeoutMs / 1000)} giây. ${last?.error || ''}`.trim(),
  );
}
