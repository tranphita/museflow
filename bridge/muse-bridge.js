(() => {
  if (window.__musetaBridgeInstalled) return;
  window.__musetaBridgeInstalled = true;
  const UI = globalThis.MusetaMuseUI;
  const { isRefusalContext, isClearRefusal, isAwaitingApproval } = globalThis.MusetaRefusal;
  const MAX_APPROVAL_REPLIES = 2;
  const APPROVAL_IDLE_MS = 4000;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'MUSETA_CHECK_SESSION') {
      checkSession().then(sendResponse, error =>
        sendResponse({ ok: false, error: error.message || String(error) }),
      );
      return true;
    }
    if (message?.type === 'MUSETA_DIAGNOSE') {
      sendResponse({ ok: true, url: location.href, checks: diagnose() });
      return false;
    }
    if (message?.type === 'MUSETA_GENERATE') {
      const controller = new AbortController();
      activeGenerations.set(message.requestId, controller);
      generate(message, controller.signal)
        .then(sendResponse, error =>
          sendResponse({
            ok: false,
            code: error.code || 'MUSE_ERROR',
            error: error.message || String(error),
          }),
        )
        .finally(() => activeGenerations.delete(message.requestId));
      return true;
    }
    if (message?.type === 'MUSETA_STOP_GENERATION') {
      const stopped = message.requestId
        ? abortGeneration(message.requestId)
        : [...activeGenerations.keys()].some(id => abortGeneration(id));
      sendResponse({ ok: true, stopped });
      return false;
    }
  });

  function findComposer() {
    const candidates = [...document.querySelectorAll(UI.selectors.composer)].filter(
      el => visible(el) && !el.disabled,
    );
    return (
      candidates.find(el => UI.text.composerPlaceholder.test(el.getAttribute('placeholder') || '')) ||
      candidates[0] ||
      null
    );
  }

  function visible(el) {
    return Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  }
  const delay = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Đã dừng tạo theo yêu cầu của bạn.', 'AbortError'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      }, ms);
      const cancel = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        reject(new DOMException('Đã dừng tạo theo yêu cầu của bạn.', 'AbortError'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
    });
  const activeGenerations = new Map();

  function clickMuseStop() {
    const button = [...document.querySelectorAll(UI.selectors.stopButton)].find(visible);
    if (button) {
      button.click();
      return true;
    }
    return false;
  }

  function abortGeneration(requestId) {
    const controller = activeGenerations.get(requestId);
    if (!controller) return false;
    controller.abort();
    clickMuseStop();
    return true;
  }

  async function checkSession() {
    await waitHydrated(5000);
    const composer = findComposer();
    const ready = Boolean(composer && visible(composer) && !composer.disabled && !composer.readOnly);
    const loginRequired =
      Boolean(document.querySelector(UI.selectors.loginField)) &&
      UI.text.loginPrompt.test(document.body?.innerText || '');
    return {
      ok: true,
      signedIn: ready && !loginRequired,
      title: document.title,
      composer: ready,
      loginRequired,
      url: location.href,
    };
  }

  async function waitHydrated(timeout, signal) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (document.readyState === 'complete' && findComposer() && isHydrated()) return;
      if (signal?.aborted) throw new DOMException('Đã dừng tạo theo yêu cầu của bạn.', 'AbortError');
      await delay(120, signal);
    }
    if (!findComposer())
      throw new Error('Khung chat Muse chưa sẵn sàng. Mở trang chat Muse và chờ ô nhập tin nhắn tải xong.');
  }

  function isHydrated() {
    const hydration = document.querySelector(UI.selectors.hydrationState);
    return !hydration || hydration.getAttribute(UI.selectors.hydrationAttribute) === 'hydrated';
  }

  function findSendButton() {
    return [...document.querySelectorAll(UI.selectors.clickable)]
      .filter(visible)
      .find(b =>
        UI.text.sendButton.test(
          `${b.getAttribute('aria-label') || ''} ${b.getAttribute('data-testid') || ''} ${b.innerText || ''}`,
        ),
      );
  }

  function findStopButton() {
    return document.querySelector(UI.selectors.stopButton);
  }

  function findImageUploadInput(composer) {
    let composerRoot = composer?.closest('form') || composer?.parentElement || null;
    for (let i = 0; i < 8 && composerRoot?.parentElement; i++) {
      if (composerRoot.querySelector(UI.selectors.fileInput)) break;
      composerRoot = composerRoot.parentElement;
    }
    const acceptsImage = input => {
      const accept = (input.accept || '').toLowerCase();
      return (
        !accept ||
        accept.includes('image') ||
        accept.includes('*/*') ||
        /\.(png|jpe?g|webp|gif|bmp|avif)/.test(accept)
      );
    };
    const all = [...document.querySelectorAll(UI.selectors.fileInput)].filter(
      input => !input.disabled && acceptsImage(input),
    );
    const isImageInput = input => /image|\.png|\.jpe?g|\.webp|\.gif|\.avif/i.test(input.accept || '');
    const input =
      all.find(input => composerRoot?.contains(input) && isImageInput(input)) ||
      all.find(input => composerRoot?.contains(input)) ||
      all.find(isImageInput) ||
      null;
    return { input, composerRoot };
  }

  function diagnose() {
    const composer = findComposer();
    const check = (id, label, found, hint) => ({ id, label, ok: Boolean(found), hint });
    return [
      check('composer', 'Ô nhập tin nhắn chat', composer, 'selectors.composer / text.composerPlaceholder'),
      check('hydrated', 'Trang Muse đã tải xong', isHydrated(), 'selectors.hydrationState'),
      findSendButton() || composer?.closest('form') || composer?.value.trim()
        ? check('send', 'Nút gửi', findSendButton() || composer?.closest('form'), 'text.sendButton')
        : {
            id: 'send',
            label: 'Nút gửi (hiện ra khi đã nhập prompt)',
            ok: null,
            hint: 'text.sendButton',
          },
      check(
        'upload',
        'Nút tải ảnh lên (cần cho ảnh tham chiếu)',
        findImageUploadInput(composer).input ||
          [...document.querySelectorAll(UI.selectors.uploadTrigger)].some(el =>
            UI.text.uploadButton.test(
              `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`,
            ),
          ),
        'selectors.fileInput / text.uploadButton',
      ),
      check(
        'login',
        'Đã đăng nhập',
        !(
          document.querySelector(UI.selectors.loginField) &&
          UI.text.loginPrompt.test(document.body?.innerText || '')
        ),
        'selectors.loginField',
      ),
    ];
  }

  function attachments() {
    return [...document.querySelectorAll(UI.selectors.attachment)]
      .filter(
        el =>
          !el.closest(UI.selectors.attachmentExcludedAncestor) && !el.closest(UI.selectors.composerOverlay),
      )
      .map(el => {
        const tid = el.getAttribute('data-testid') || '',
          video = el.querySelector('video'),
          image = el.querySelector('img');
        const urls = [...el.querySelectorAll(UI.selectors.attachmentMediaLink)]
          .map(item => ({
            url:
              item.href ||
              item.src ||
              item.getAttribute('data-video-src') ||
              item.getAttribute('data-download-url') ||
              '',
            download: item.getAttribute('download') || '',
            type: item.getAttribute('type') || '',
          }))
          .filter(item => item.url);
        const videoLink =
          urls.find(
            item =>
              /video\//i.test(item.type) ||
              /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i.test(item.url) ||
              /\.(?:mp4|webm|mov|m4v)$/i.test(item.download),
          )?.url || '';
        const videoUrl = video?.currentSrc || video?.src || videoLink || '';
        const media = video || image;
        return {
          el,
          tid,
          src: videoUrl || media?.currentSrc || media?.src || '',
          videoUrl,
          isVideo: Boolean(videoUrl) || video instanceof HTMLVideoElement || /video/i.test(tid),
          width: video?.videoWidth || image?.naturalWidth || 0,
          height: video?.videoHeight || image?.naturalHeight || 0,
        };
      })
      .filter(a => a.src);
  }

  function waitForAttachmentChange(timeoutMs, signal) {
    return new Promise(resolve => {
      let timer;
      const observer = new MutationObserver(() => finish());
      const finish = () => {
        observer.disconnect();
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          'src',
          'poster',
          'href',
          'download',
          'type',
          'data-testid',
          'data-video-src',
          'data-download-url',
        ],
      });
      timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  function assistantMessageElements() {
    return [...document.querySelectorAll(UI.selectors.assistantMessage)].filter(
      el => visible(el) && !el.closest(UI.selectors.userMessage),
    );
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw new DOMException('Đã dừng tạo theo yêu cầu của bạn.', 'AbortError');
  }

  const bubbleText = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();

  function snapshotAssistantTexts() {
    return new Map(assistantMessageElements().map(el => [el, bubbleText(el)]));
  }

  function readNewAssistantContext(previousBubbleTexts) {
    const bubbles = assistantMessageElements();
    // Muse wraps assistant replies in group containers too; excluding every group/msg
    // ancestor accidentally filtered out the refusal text that should trigger retry.
    const messages = bubbles
      .map(el => ({ el, text: bubbleText(el) }))
      .filter(item => item.text && item.text !== previousBubbleTexts.get(item.el));
    return messages
      .map(item => item.text)
      .join('\n')
      .slice(-6000);
  }

  async function submitMessage(composer, text, signal) {
    composer.scrollIntoView({ block: 'center' });
    composer.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Ô nhập tin nhắn của Muse không được hỗ trợ.');
    setter.call(composer, String(text));
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
    let sendButton = null;
    for (let i = 0; i < 30; i++) {
      throwIfAborted(signal);
      sendButton = findSendButton();
      if (sendButton && !sendButton.disabled) break;
      await delay(100, signal);
    }
    if (!composer.value.trim())
      throw new Error('Muse không nhận prompt vào ô nhập tin nhắn. Chưa có gì được gửi.');
    const bubbleCount = () => document.querySelectorAll(UI.selectors.chatBubble).length;
    const beforeSendCount = bubbleCount();
    let submitted = false;
    throwIfAborted(signal);
    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      submitted = true;
    } else {
      // Match M2A's keyboard fallback: submit once only when Muse exposes no active Send button.
      const form = composer.closest('form');
      if (form && typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        submitted = true;
      } else {
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        submitted = true;
      }
    }
    let accepted = false;
    for (let i = 0; i < 30; i++) {
      throwIfAborted(signal);
      if (
        !composer.isConnected ||
        !composer.value.trim() ||
        bubbleCount() > beforeSendCount ||
        findStopButton()
      ) {
        accepted = true;
        break;
      }
      await delay(100, signal);
    }
    if (!submitted || !accepted)
      throw new Error(
        'Muse không xác nhận đã gửi prompt. Kiểm tra khung chat rồi thử lại; Museta sẽ không tự gửi lại.',
      );
  }

  async function generate(
    {
      prompt,
      timeoutSec = 600,
      mediaType = 'image',
      referenceImage = '',
      referenceImages = [],
      size = '1:1',
      requestId,
    },
    signal,
  ) {
    throwIfAborted(signal);
    const mediaWord = mediaType === 'video' ? 'video' : 'ảnh';
    if (!String(prompt || '').trim()) throw new Error('Prompt đang trống.');
    await waitHydrated(15000, signal);
    throwIfAborted(signal);
    const composer = findComposer();
    if (!visible(composer))
      throw new Error('Không thấy ô nhập tin nhắn của Muse. Mở khung chat rồi thử lại.');
    const referenceList =
      Array.isArray(referenceImages) && referenceImages.length
        ? referenceImages
        : referenceImage
          ? [referenceImage]
          : [];
    if (referenceList.length) await attachReferences(referenceList, signal);
    throwIfAborted(signal);
    const baseline = new Set(attachments().map(a => a.src));
    const priorBubbleTexts = snapshotAssistantTexts();
    await submitMessage(composer, prompt, signal);
    const deadline = Date.now() + Math.min(900, Math.max(30, Number(timeoutSec) || 600)) * 1000;
    let lastProgress = Date.now(),
      firstWrongRatioAt = 0;
    let refusalContext = '',
      refusalContextSince = 0,
      approvalReplies = 0,
      approvalContextSince = 0;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const fresh = attachments().filter(a => !baseline.has(a.src));
      const matching = fresh.filter(a => (mediaType === 'video' ? a.isVideo : !a.isVideo));
      const [ratioW, ratioH] = String(size || '1:1')
          .split(':')
          .map(Number),
        expectedRatio = ratioW > 0 && ratioH > 0 ? ratioW / ratioH : 1;
      const measured = matching
        .filter(a => a.width > 0 && a.height > 0)
        .sort((a, b) => {
          const scoreA = Math.abs(Math.log(a.width / a.height / expectedRatio)),
            scoreB = Math.abs(Math.log(b.width / b.height / expectedRatio));
          if (Math.abs(scoreA - scoreB) > 0.015) return scoreA - scoreB;
          return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1;
        });
      const best = measured[0],
        bestRatioError = best ? Math.abs(Math.log(best.width / best.height / expectedRatio)) : Infinity;
      if (best && bestRatioError <= 0.09) firstWrongRatioAt = 0;
      else if (best && !firstWrongRatioAt) firstWrongRatioAt = Date.now();
      const result = best && (bestRatioError <= 0.09 || Date.now() - firstWrongRatioAt >= 3500) ? best : null;
      if (result) {
        const media =
          mediaType === 'video'
            ? result.el.querySelector('video') || null
            : result.el.querySelector('img') || null;
        const src =
          mediaType === 'video'
            ? result.videoUrl || media?.currentSrc || media?.src || ''
            : media?.currentSrc || media?.src || '';
        // Muse may first render a poster and attach the playable/download URL after
        // hydration. Keep waiting for that URL instead of rejecting a completed clip.
        if (!src) {
          firstWrongRatioAt = firstWrongRatioAt || Date.now();
          await waitForAttachmentChange(Math.min(500, deadline - Date.now()), signal);
          continue;
        }
        if (mediaType === 'video' && !src.startsWith('blob:') && !src.startsWith('data:'))
          return { ok: true, url: src };
        if (src.startsWith('data:')) return { ok: true, url: src };
        try {
          const response = await fetch(src, { credentials: 'include' });
          if (!response.ok) throw new Error(`Tải ${mediaWord} về trả lỗi HTTP ${response.status}.`);
          const blob = await response.blob();
          return { ok: true, url: await blobToDataUrl(blob) };
        } catch (error) {
          return {
            ok: true,
            url: src,
            error: `Đã thấy ${mediaWord} mới nhưng không sao chép về máy được: ${error.message}`,
          };
        }
      }
      const stop = Boolean(findStopButton());
      const currentContext = readNewAssistantContext(priorBubbleTexts),
        refusal = isRefusalContext(currentContext);
      if (refusal) {
        if (currentContext !== refusalContext) {
          refusalContext = currentContext;
          refusalContextSince = Date.now();
        }
        if (isClearRefusal(currentContext) || Date.now() - refusalContextSince >= 1200) {
          if (stop) clickMuseStop();
          const error = new Error(`Muse không tạo được cảnh này: ${currentContext.slice(-700)}`);
          error.code = 'SCENE_REFUSED';
          throw error;
        }
      } else {
        refusalContext = '';
        refusalContextSince = 0;
      }
      if (!stop && !refusal && approvalReplies < MAX_APPROVAL_REPLIES && isAwaitingApproval(currentContext)) {
        approvalContextSince = approvalContextSince || Date.now();
        if (Date.now() - approvalContextSince >= APPROVAL_IDLE_MS) {
          approvalReplies++;
          approvalContextSince = 0;
          for (const [el, text] of snapshotAssistantTexts()) priorBubbleTexts.set(el, text);
          await submitMessage(findComposer(), approvalReply(mediaWord), signal);
          continue;
        }
      } else approvalContextSince = 0;
      if (!stop && Date.now() - lastProgress > 5000) {
        const tail = (document.body?.innerText || '').slice(-800);
        if (UI.text.outOfCredits.test(tail))
          throw new Error('Tài khoản Muse không đủ credit tạo ảnh. Hãy nạp thêm credit rồi thử lại.');
      }
      await waitForAttachmentChange(Math.min(500, deadline - Date.now()), signal);
    }
    throwIfAborted(signal);
    throw new Error(
      `Hết thời gian chờ ${mediaWord} mới từ Muse. Prompt đã được gửi một lần và không gửi lại.`,
    );
  }

  async function attachReferences(references, signal) {
    const files = await Promise.all(
      references.map(async (reference, index) => {
        const url = typeof reference === 'string' ? reference : reference?.url;
        if (!url) throw new Error(`Ảnh tham chiếu ${index + 1} không có URL.`);
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error(`Không tải được ảnh tham chiếu ${index + 1} (${response.status}).`);
        const blob = await response.blob();
        if (!blob.type.startsWith('image/') || !blob.size)
          throw new Error(`Ảnh tham chiếu ${index + 1} không đọc được.`);
        const extension =
          (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
        return new File([blob], `museta-reference-${String(index + 1).padStart(2, '0')}.${extension}`, {
          type: blob.type,
        });
      }),
    );
    const composer = findComposer();
    const { composerRoot } = findImageUploadInput(composer);
    const findInput = () => findImageUploadInput(composer).input;
    let input = findInput();
    if (!input) {
      const roots = [composerRoot, composer.closest('form'), composer.parentElement].filter(Boolean);
      const uploadButton = roots
        .flatMap(root => [...root.querySelectorAll(UI.selectors.uploadTrigger)])
        .filter(visible)
        .find(el =>
          UI.text.uploadButton.test(
            `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.innerText || ''}`,
          ),
        );
      if (uploadButton) {
        uploadButton.click();
        await delay(250, signal);
        input = findInput();
      }
    }
    if (!input)
      throw new Error('Không tìm thấy nút tải ảnh lên của Muse gần khung chat; prompt chưa được gửi.');
    const previewElements = () => [...document.querySelectorAll(UI.selectors.uploadPreview)].filter(visible);
    const previewKey = el => {
      const src = el.matches('img')
        ? el.currentSrc || el.src || ''
        : /url\(["']?(blob:|data:image\/|https?:)[^)]*\)/i.exec(getComputedStyle(el).backgroundImage)?.[0] ||
          '';
      return `${src}|${el.getAttribute('data-testid') || ''}|${el.getAttribute('class') || ''}|${el.getAttribute('aria-label') || ''}|${el.getAttribute('title') || ''}`;
    };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (!setter) throw new Error('Trình duyệt không cho phép gán file vào ô đính kèm của Muse.');
    const uploadBatch = async batch => {
      const previousPreviews = new Set(previewElements().map(previewKey));
      const transfer = new DataTransfer();
      batch.forEach(file => transfer.items.add(file));
      if (batch.length > 1) input.multiple = true;
      setter.call(input, transfer.files);
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      const started = Date.now(),
        deadline = started + 8000;
      const accepted = () =>
        batch.every(file =>
          [...(input.files || [])].some(
            item => item.name === file.name && item.size === file.size && item.type === file.type,
          ),
        );
      const previewSeen = () =>
        previewElements().some(el => {
          const key = previewKey(el),
            src = el.matches('img') ? el.currentSrc || el.src || '' : key.split('|', 1)[0];
          return !previousPreviews.has(key) && Boolean(src);
        });
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new DOMException('Đã dừng tạo theo yêu cầu của bạn.', 'AbortError');
        if (previewSeen() || (accepted() && Date.now() - started > 1000)) return;
        await delay(160, signal);
      }
      throw new Error(
        `Muse không xác nhận ${batch.length} ảnh tham chiếu trong khung chat (ô tải lên nhận: ${input.accept || 'mọi loại file'}); prompt chưa được gửi.`,
      );
    };
    if (files.length > 1 && !input.multiple) {
      for (const file of files) await uploadBatch([file]);
    } else await uploadBatch(files);
  }

  function approvalReply(mediaWord) {
    return `Duyệt. Tạo ngay ${mediaWord} theo đúng yêu cầu ở tin nhắn trước của mình, không cần hỏi lại. Mọi yêu cầu tiếp theo trong cuộc chat này cũng đã được duyệt sẵn, cứ tạo luôn.`;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Chuyển đổi media thất bại.'));
      reader.readAsDataURL(blob);
    });
  }
})();
