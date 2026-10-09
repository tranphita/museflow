// Every Muse.ai page hook lives here. When Muse changes its interface, update this file
// and run "Check Muse session" in Museta Settings to see which hooks still match.
globalThis.MusetaMuseUI = Object.freeze({
  selectors: {
    composer: 'textarea',
    hydrationState: '[data-hatch-shell-hydration-state]',
    hydrationAttribute: 'data-hatch-shell-hydration-state',
    stopButton:
      '[data-testid="hatch-composer-stop-button"],button[aria-label*="Stop" i],button[aria-label*="停止"]',
    clickable: 'button,[role="button"]',
    attachment: '[data-testid^="hatch-chat-attachment-presentation-"]',
    attachmentExcludedAncestor: 'form,[class*="chat-user-bubble"],[class*="group/msg"]',
    composerOverlay: '[data-testid="hatch-composer-placeholder-overlay"]',
    attachmentMediaLink: 'a[href],video source[src],source[src],[data-video-src],[data-download-url]',
    chatBubble: 'div[class*="hatch-chat-groupable-bubble"]',
    assistantMessage:
      'div[class*="hatch-chat-groupable-bubble"],[data-message-author-role="assistant"],[data-testid*="assistant" i],[data-testid*="message-content" i],[class*="assistant-message" i],[class*="assistant-bubble" i]',
    userMessage:
      '[class*="chat-user-bubble"],[data-message-author-role="user"],[data-testid*="user-message" i]',
    loginField: 'input[type="password"],button[type="submit"]',
    fileInput: 'input[type="file"]',
    uploadTrigger: 'button,[role="button"],label',
    uploadPreview:
      'img,[role="img"],[data-testid*="attachment" i],[data-testid*="upload" i],[class*="attachment" i],[class*="upload" i]',
  },
  text: {
    composerPlaceholder: /message|消息/i,
    sendButton: /send|发送/i,
    loginPrompt: /sign in|log in|登录/i,
    uploadButton: /attach|upload|image|photo|file|đính kèm|tải lên/i,
    outOfCredits: /out of credits|insufficient credits|额度不足|积分不足/i,
  },
});
