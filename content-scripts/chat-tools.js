(function () {
  // background can inject this script twice for the same document (onCompleted + onHistoryStateUpdated racing)
  if (window.__hhaaChatToolsInjected) return;
  window.__hhaaChatToolsInjected = true;

  const SETTINGS_KEY = 'hhaa_settings';
  const DIAGNOSTIC_LOG_KEY = 'hhaa_diagnosticLog';

  const CHAT_CELL_PREFIX = 'chatik-open-chat-';
  const SUBTITLE_SELECTOR = '[data-qa="chat-cell-subtitle"]';
  const MESSAGE_TEXTAREA_SELECTOR = '[data-qa="chatik-new-message-text"]';
  const SEND_BUTTON_SELECTOR = '[data-qa="chatik-do-send-message"]';

  const QUICK_SEND_BUTTON_CLASS = 'hhaa-quick-send-btn';
  const MESSAGE_DELAY_MS = 1000;

  const INCOMING_MESSAGE_ID_RE = /^chatik-chat-message-(\d+)$/;
  const INCOMING_BUBBLE_CLASS_HINT = 'chat-bubble_incoming';
  const MESSAGE_TEXT_SELECTOR = '[data-qa="chat-bubble-text"]';
  const LLM_REPLY_BUTTON_CLASS = 'hhaa-llm-reply-btn';

  const POLL_INTERVAL_MS = 500;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(predicate, { timeout = 5000, interval = 150 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = predicate();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  async function getSettings() {
    const r = await chrome.storage.local.get(SETTINGS_KEY);
    return r[SETTINGS_KEY] || {};
  }

  // one message per line — blank lines are dropped, not sent. That's what lets a settings textarea
  // use a blank line to visually separate two messages without it becoming a third, empty message.
  function normalizeMessageLines(raw) {
    return (raw || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async function addDiagnosticLogEntry(entry) {
    const r = await chrome.storage.local.get(DIAGNOSTIC_LOG_KEY);
    const list = r[DIAGNOSTIC_LOG_KEY] || [];
    list.push(entry);
    if (list.length > 1500) list.splice(0, list.length - 1500);
    await chrome.storage.local.set({ [DIAGNOSTIC_LOG_KEY]: list });
  }

  function warn(message, context) {
    console.warn(`💬 [chat-tools] ${message}`);
    return addDiagnosticLogEntry({ at: Date.now(), level: 'warn', module: 'chat-tools', message, context });
  }

  // React-controlled textarea, same technique already proven on the cover-letter box in vacancy-list.js
  function fillNativeTextarea(textarea, value) {
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function currentChatId() {
    const match = location.pathname.match(/^\/chat\/(\d+)/);
    return match ? match[1] : null;
  }

  function injectStyleOnce() {
    if (document.getElementById('hhaa-chat-tools-style')) return;
    const style = document.createElement('style');
    style.id = 'hhaa-chat-tools-style';
    style.textContent = `
      .${QUICK_SEND_BUTTON_CLASS} {
        margin-left: auto;
        flex-shrink: 0;
        width: 110px;
        height: 33px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        font-size: 17px;
        font-weight: 700;
        line-height: 1;
        color: #fff;
        background: linear-gradient(135deg, #d6001c, #a80016);
        border: none;
        border-radius: 10px;
        cursor: pointer;
        box-shadow: 0 2px 6px rgba(214, 0, 28, 0.35);
      }
      .${QUICK_SEND_BUTTON_CLASS}:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .${LLM_REPLY_BUTTON_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        margin-top: 8px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 700;
        font-family: inherit;
        color: #fff;
        background: linear-gradient(135deg, #d6001c, #a80016);
        border: none;
        border-radius: 8px;
        cursor: pointer;
        box-shadow: 0 2px 6px rgba(214, 0, 28, 0.3);
      }
      .${LLM_REPLY_BUTTON_CLASS}:disabled {
        cursor: default;
        opacity: 0.85;
      }
      .hhaa-llm-spinner {
        display: inline-block;
        width: 13px;
        height: 13px;
        border: 2px solid rgba(255, 255, 255, 0.4);
        border-top-color: #fff;
        border-radius: 50%;
        animation: hhaa-llm-spin 0.7s linear infinite;
      }
      @keyframes hhaa-llm-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `;
    document.head.appendChild(style);
  }

  // ---- quick-send: one button next to the currently open chat's own cell in the left list ----

  // the row holding the (usually short) last-message preview — the same row hh.ru puts the blue
  // unread-count badge in on the right when the chat has unread messages. Anchored off
  // chat-cell-subtitle's next sibling rather than that row's own hashed, build-specific class name.
  function findQuickSendAnchorRow(chatId) {
    const cell = document.querySelector(`[data-qa="${CHAT_CELL_PREFIX}${chatId}"]`);
    const subtitle = cell?.querySelector(SUBTITLE_SELECTOR);
    return subtitle?.nextElementSibling || null;
  }

  async function handleQuickSendClick(button, chatId) {
    if (button.disabled) return;
    button.disabled = true;

    try {
      // re-check everything fresh at click time instead of trusting the poll loop's last snapshot —
      // the active chat or its composer could have changed in the moment between render and click
      if (currentChatId() !== chatId) {
        await warn('chat changed before send could start, aborting', `expected=${chatId} actual=${currentChatId()}`);
        return;
      }

      const settings = await getSettings();
      const messages = normalizeMessageLines(settings.chatQuickMessagesRaw);
      if (messages.length === 0) {
        await warn('no chat-quick-send messages configured in settings, nothing to send');
        return;
      }

      for (let i = 0; i < messages.length; i++) {
        const textarea = document.querySelector(MESSAGE_TEXTAREA_SELECTOR);
        const sendButton = document.querySelector(SEND_BUTTON_SELECTOR);
        if (!textarea || !sendButton) {
          await warn('composer disappeared mid-send', `chatId=${chatId} messageIndex=${i}`);
          return;
        }

        fillNativeTextarea(textarea, messages[i]);
        const enabled = await waitFor(() => !sendButton.disabled, { timeout: 2000 });
        if (!enabled) {
          await warn('send button stayed disabled after filling the message', `chatId=${chatId} messageIndex=${i}`);
          return;
        }

        sendButton.click();
        const cleared = await waitFor(() => document.querySelector(MESSAGE_TEXTAREA_SELECTOR)?.value === '', {
          timeout: 3000,
        });
        if (!cleared) {
          await warn('send did not clear the composer, treating as failed', `chatId=${chatId} messageIndex=${i}`);
          return;
        }

        if (i < messages.length - 1) await sleep(MESSAGE_DELAY_MS);
      }

      console.log(`💬 [chat-tools] sent ${messages.length} message(s) to chat ${chatId}`);
    } finally {
      button.disabled = false;
    }
  }

  function createQuickSendButton(chatId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = QUICK_SEND_BUTTON_CLASS;
    button.dataset.chatId = chatId;
    button.title = 'Отправить сообщения из настроек';
    button.textContent = 'ᯓ➤';
    button.addEventListener('click', (event) => {
      // the row lives inside the chat cell's own <a> — without this the click would also open/reopen
      // the chat (harmless here since it's already open, but stopping it is the correct intent anyway)
      event.preventDefault();
      event.stopPropagation();
      handleQuickSendClick(button, chatId);
    });
    return button;
  }

  function syncQuickSendButton(chatId, hasComposer) {
    const existing = document.querySelector(`.${QUICK_SEND_BUTTON_CLASS}`);

    if (!chatId || !hasComposer) {
      existing?.remove();
      return;
    }

    const anchorRow = findQuickSendAnchorRow(chatId);
    if (!anchorRow) {
      // the active chat's own cell isn't currently rendered by the virtualized list (scrolled out
      // of view) — nothing to anchor to yet, the next tick retries once it scrolls back into view
      existing?.remove();
      return;
    }

    if (existing && anchorRow.contains(existing) && existing.dataset.chatId === chatId) return;

    existing?.remove();
    anchorRow.appendChild(createQuickSendButton(chatId));
  }

  // ---- LLM reply: one button per incoming (employer) message, drafts a reply into the composer ----

  function getIncomingMessages() {
    return Array.from(document.querySelectorAll('[data-qa^="chatik-chat-message-"]'))
      .map((container) => {
        const messageId = container.getAttribute('data-qa')?.match(INCOMING_MESSAGE_ID_RE)?.[1];
        return messageId ? { container, messageId } : null;
      })
      .filter(Boolean)
      .filter(({ container }) => container.querySelector(`[class*="${INCOMING_BUBBLE_CLASS_HINT}"]`));
  }

  function getBubbleContentEl(container, messageId) {
    return container.querySelector(`[data-qa="chatik-chat-message-${messageId}-text"]`);
  }

  function getMessageText(container) {
    // innerText (not textContent) so paragraph/list breaks the user actually sees on screen survive
    // into the LLM prompt — the message body has <p>/<hr> structure that textContent would flatten
    return container.querySelector(MESSAGE_TEXT_SELECTOR)?.innerText?.trim() || '';
  }

  async function handleLlmReplyClick(button, messageId, messageText) {
    if (button.disabled) return;

    const originalContent = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="hhaa-llm-spinner"></span>';

    try {
      const settings = await getSettings();

      if (!settings.apiKey || !settings.apiKey.trim()) {
        await warn('LLM API key not configured, cannot generate a chat reply');
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: 'HHAA_GENERATE_CHAT_REPLY',
        payload: {
          apiKey: settings.apiKey,
          legend: settings.legend,
          chatPrompt: settings.chatLlmPromptRaw,
          messageText,
          modelsRaw: settings.llmModelsRaw,
        },
      });

      if (!response?.success) {
        await warn('LLM chat reply failed', `messageId=${messageId} error=${response?.error}`);
        return;
      }

      const textarea = document.querySelector(MESSAGE_TEXTAREA_SELECTOR);
      if (!textarea) {
        await warn('composer disappeared before the LLM reply could be inserted', `messageId=${messageId}`);
        return;
      }

      // append rather than overwrite — the user may already be drafting something, or may re-roll
      // the LLM answer with a tweaked prompt and want to compare/keep both attempts
      const existingText = textarea.value.trim();
      const nextValue = existingText ? `${existingText}\n\n${response.data.text}` : response.data.text;
      fillNativeTextarea(textarea, nextValue);
      console.log(`💬 [chat-tools] inserted LLM reply for message ${messageId} (not sent)`);
    } catch (error) {
      await warn(`LLM chat reply threw: ${error.message}`, error.stack);
    } finally {
      button.disabled = false;
      button.innerHTML = originalContent;
    }
  }

  function createLlmReplyButton(messageId, messageText) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = LLM_REPLY_BUTTON_CLASS;
    button.title = 'Сгенерировать ответ через LLM и вставить в поле сообщения';
    button.textContent = '🤖 Ответ через LLM';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      handleLlmReplyClick(button, messageId, messageText);
    });
    return button;
  }

  function syncLlmReplyButtons(hasComposer) {
    if (!hasComposer) {
      document.querySelectorAll(`.${LLM_REPLY_BUTTON_CLASS}`).forEach((button) => {
        // a request already in flight keeps running (its own try/finally handles cleanup); only
        // drop buttons that are just sitting idle with nothing to lose by disappearing
        if (!button.disabled) button.remove();
      });
      return;
    }

    for (const { container, messageId } of getIncomingMessages()) {
      const bubbleContentEl = getBubbleContentEl(container, messageId);
      if (!bubbleContentEl || bubbleContentEl.querySelector(`.${LLM_REPLY_BUTTON_CLASS}`)) continue;

      const text = getMessageText(container);
      if (!text) continue;

      bubbleContentEl.appendChild(createLlmReplyButton(messageId, text));
    }
  }

  // ---- shared poll loop ----

  async function tick() {
    const chatId = currentChatId();
    const hasComposer = Boolean(
      chatId && document.querySelector(MESSAGE_TEXTAREA_SELECTOR) && document.querySelector(SEND_BUTTON_SELECTOR),
    );

    if (hasComposer) injectStyleOnce();
    syncQuickSendButton(chatId, hasComposer);
    syncLlmReplyButtons(hasComposer);
  }

  setInterval(() => {
    tick().catch((error) => warn(`tick failed: ${error.message}`, error.stack));
  }, POLL_INTERVAL_MS);
  tick();
})();
