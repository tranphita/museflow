import { $, museStatus } from './dom.js';

export const MESSAGE = Object.freeze({
  checkSession: 'MUSETA_CHECK_SESSION',
  diagnose: 'MUSETA_DIAGNOSE',
  generate: 'MUSETA_GENERATE',
  stopGeneration: 'MUSETA_STOP_GENERATION',
});
const MUSE_TAB_URLS = ['https://muse.ai/*', 'https://*.muse.ai/*'];
const BRIDGE_FILES = ['bridge/muse-ui.js', 'bridge/refusal.js', 'bridge/muse-bridge.js'];

const stoppedError = () => new DOMException('Generation stopped by user.', 'AbortError');

export let preferredMuseTabId = null;

export function queryMuseTabs() {
  return chrome.tabs.query({ url: MUSE_TAB_URLS });
}

export async function museTabMessage(message, preferredTabId, signal) {
  if (signal?.aborted) throw stoppedError();
  const tabs = await queryMuseTabs();
  if (!tabs.length) throw new Error('Open Muse.ai and sign in, then retry.');
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
      if (response === undefined) throw new Error('The Muse page bridge did not answer.');
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
    `Muse tab found, but Museta could not attach its page bridge: ${lastError || 'unknown browser error'}. Check Muse site access in the browser extension settings, then retry.`,
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
    item.className = check.ok ? 'ok' : 'error';
    item.textContent = `${check.ok ? '✓' : '✗'} ${check.label}`;
    if (!check.ok) item.title = `Update bridge/muse-ui.js → ${check.hint}`;
    list.appendChild(item);
  }
}

export async function testMuseSession(preferredTabId) {
  const button = $('#testMuseBtn'),
    status = $('#connectionStatus');
  if (button) button.disabled = true;
  status.className = 'warn';
  status.textContent = 'Checking Muse session…';
  try {
    const result = await museTabMessage({ type: MESSAGE.checkSession }, preferredTabId);
    if (!result?.ok) throw new Error(result?.error || 'Muse session check failed.');
    const diagnostics = await museTabMessage({ type: MESSAGE.diagnose }, preferredMuseTabId).catch(
      () => null,
    );
    renderDiagnostics(diagnostics?.checks);
    const failedHooks = (diagnostics?.checks || []).filter(check => !check.ok && check.id !== 'login');
    const ready = Boolean(result.composer && result.signedIn);
    status.className = ready && !failedHooks.length ? 'ok' : 'warn';
    status.textContent = failedHooks.length
      ? `Muse page changed: ${failedHooks.map(check => check.label).join(', ')} not found. Generation may fail until bridge/muse-ui.js is updated.`
      : ready
        ? 'Muse session connected.'
        : result.loginRequired
          ? 'Muse asks you to sign in. Sign in on the Muse tab, then check again.'
          : result.composer
            ? 'Muse chat is ready. Session state could not be confirmed; generation can still be tried.'
            : 'Muse tab found, but its chat message box is not ready. Open a Muse chat and try again.';
    museStatus.textContent = ready ? '● Muse session ready' : '● Muse session needs attention';
    museStatus.className = ready ? 'ok' : result.loginRequired ? 'warn' : 'ok';
    if (!ready && !result.loginRequired) museStatus.textContent = '● Muse chat ready · session unconfirmed';
    if (failedHooks.length) {
      museStatus.textContent = '● Muse page changed · open Settings';
      museStatus.className = 'warn';
    }
    return ready || Boolean(result.composer && !result.loginRequired);
  } catch (error) {
    status.className = 'error';
    status.textContent = error.message;
    renderDiagnostics([]);
    museStatus.textContent = '● Muse session check failed';
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
      museStatus.textContent = '● Open muse.ai and sign in';
      museStatus.className = 'warn';
    }
  } catch {
    museStatus.textContent = '● Muse session check unavailable';
    museStatus.className = 'warn';
  }
}
