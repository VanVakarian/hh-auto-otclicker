(function () {
  // background can inject this script twice for the same document (onCompleted + onHistoryStateUpdated racing)
  if (window.__hhaaChatToolsInjected) return;
  window.__hhaaChatToolsInjected = true;

  const SETTINGS_KEY = 'hhaa_settings';
  const DIAGNOSTIC_LOG_KEY = 'hhaa_diagnosticLog';

  const CHAT_CELL_PREFIX = 'chatik-open-chat-';
  const SUBTITLE_SELECTOR = '[data-qa="chat-cell-subtitle"]';
  // the one stable, non-hashed handle on hh.ru's whole composer box
  const COMPOSER_WRAPPER_SELECTOR = '[data-qa="chatik-message-input"]';
  // the textarea's own data-qa="text-input" is a generic magritte name reused by other inputs
  // across the site, so it's always scoped to inside the composer wrapper, never queried bare
  const MESSAGE_TEXTAREA_SELECTOR = `${COMPOSER_WRAPPER_SELECTOR} textarea`;
  // only rendered once the textarea has text (it replaces the voice-record button there) — never
  // query this before the message has been typed in, see sendComposerMessage below
  const SEND_BUTTON_SELECTOR = '[data-qa="chatik-do-send-message"]';

  const QUICK_SEND_BUTTON_CLASS = 'hhaa-quick-send-btn';
  const MESSAGE_DELAY_MS = 1000;

  const SUGGESTED_REPLIES_BLOCK_CLASS = 'hhaa-suggested-replies';
  const SUGGESTED_REPLY_BUTTON_CLASS = 'hhaa-suggested-reply-btn';

  const INCOMING_MESSAGE_ID_RE = /^chatik-chat-message-(\d+)$/;
  // human employer replies use chat-bubble_incoming, hh's own "AI assistant" replies use
  // chat-bubble_bot — both are messages the applicant didn't send, so both get the LLM-reply button
  const INCOMING_BUBBLE_CLASS_HINTS = ['chat-bubble_incoming', 'chat-bubble_bot'];
  const MESSAGE_TEXT_SELECTOR = '[data-qa="chat-bubble-text"]';
  const LLM_REPLY_BUTTON_CLASS = 'hhaa-llm-reply-btn';

  // hh.ru mounts the composer/quick-reply UI with its own visible render delay after a chat opens
  // (~200-300ms) — a MutationObserver reacts to that mount directly instead of stacking a blind
  // poll interval on top of it, see the reactive loop at the bottom of this file
  const TICK_THROTTLE_MS = 100;
  const FALLBACK_POLL_INTERVAL_MS = 2000;

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

  // Chrome invalidates every chrome.* call in an already-loaded content script the moment the
  // extension itself is reloaded/updated (routine during dev) — the tab keeps running old JS with
  // no way back into the extension, and this is the one error message Chrome uses for that state.
  function isContextInvalidatedError(error) {
    return typeof error?.message === 'string' && error.message.includes('Extension context invalidated');
  }

  // a logging helper must never itself throw: it's always called from a catch/finally path, so a
  // failure here would replace the original error with a confusing one about the logger instead
  function warn(message, context) {
    console.warn(`💬 [chat-tools] ${message}`);
    return addDiagnosticLogEntry({ at: Date.now(), level: 'warn', module: 'chat-tools', message, context }).catch(
      (error) => {
        if (isContextInvalidatedError(error)) haltOnContextInvalidated();
        // any other storage failure here is already reported via the console.warn above
      },
    );
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
      .${SUGGESTED_REPLIES_BLOCK_CLASS} {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
        padding: 10px 16px;
      }
      .${SUGGESTED_REPLY_BUTTON_CLASS} {
        padding: 6px 14px;
        font-size: 13px;
        font-weight: 600;
        font-family: inherit;
        color: #d6001c;
        background: #fff;
        border: 1.5px solid #d6001c;
        border-radius: 20px;
        cursor: pointer;
      }
      .${SUGGESTED_REPLY_BUTTON_CLASS}:hover {
        background: #fff2f3;
      }
      .${SUGGESTED_REPLY_BUTTON_CLASS}:disabled {
        opacity: 0.5;
        cursor: default;
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

  // fills the composer, sends, and waits for it to clear — the one send path shared by the
  // multi-message quick-send button and the single-click suggested-reply buttons below
  async function sendComposerMessage(text, warnContext) {
    const textarea = document.querySelector(MESSAGE_TEXTAREA_SELECTOR);
    if (!textarea) {
      await warn('composer textarea not found while trying to send a message', warnContext);
      return false;
    }

    fillNativeTextarea(textarea, text);

    // the send button only mounts once the textarea has text (it replaces the voice-record button
    // there), so it can't be queried until after fillNativeTextarea above
    const sendButton = await waitFor(() => document.querySelector(SEND_BUTTON_SELECTOR), { timeout: 2000 });
    if (!sendButton) {
      await warn('send button never appeared after filling the message', warnContext);
      return false;
    }

    const enabled = await waitFor(() => !sendButton.disabled, { timeout: 2000 });
    if (!enabled) {
      await warn('send button stayed disabled after filling the message', warnContext);
      return false;
    }

    sendButton.click();
    const cleared = await waitFor(() => document.querySelector(MESSAGE_TEXTAREA_SELECTOR)?.value === '', {
      timeout: 3000,
    });
    if (!cleared) {
      await warn('send did not clear the composer, treating as failed', warnContext);
      return false;
    }

    return true;
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
        const sent = await sendComposerMessage(messages[i], `chatId=${chatId} messageIndex=${i}`);
        if (!sent) return;
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

  // ---- suggested replies: one button per configured message, sends it standalone on click,
  // rendered right above the composer like hh.ru's own "quick reply" chips ----

  function findComposerAnchor() {
    return document.querySelector(COMPOSER_WRAPPER_SELECTOR);
  }

  async function handleSuggestedReplyClick(button, chatId, text) {
    if (button.disabled) return;
    button.disabled = true;

    try {
      if (currentChatId() !== chatId) {
        await warn(
          'chat changed before suggested reply could send, aborting',
          `expected=${chatId} actual=${currentChatId()}`,
        );
        return;
      }

      const sent = await sendComposerMessage(text, `chatId=${chatId}`);
      if (sent) console.log(`💬 [chat-tools] sent suggested reply to chat ${chatId}`);
    } finally {
      button.disabled = false;
    }
  }

  function createSuggestedRepliesBlock(chatId, messages) {
    const block = document.createElement('div');
    block.className = SUGGESTED_REPLIES_BLOCK_CLASS;
    block.dataset.chatId = chatId;
    block.dataset.signature = `${chatId}::${messages.join(' ')}`;

    for (const text of messages) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = SUGGESTED_REPLY_BUTTON_CLASS;
      button.title = 'Отправить это сообщение';
      button.textContent = text;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleSuggestedReplyClick(button, chatId, text);
      });
      block.appendChild(button);
    }

    return block;
  }

  async function syncSuggestedReplies(chatId, hasComposer) {
    const existing = document.querySelector(`.${SUGGESTED_REPLIES_BLOCK_CLASS}`);

    if (!chatId || !hasComposer) {
      existing?.remove();
      return;
    }

    const settings = await getSettings();
    const messages = normalizeMessageLines(settings.chatSuggestedRepliesRaw);
    if (messages.length === 0) {
      existing?.remove();
      return;
    }

    const signature = `${chatId}::${messages.join(' ')}`;
    if (existing && existing.dataset.signature === signature) return;

    const anchor = findComposerAnchor();
    if (!anchor?.parentNode) {
      existing?.remove();
      return;
    }

    existing?.remove();
    anchor.parentNode.insertBefore(createSuggestedRepliesBlock(chatId, messages), anchor);
  }

  // ---- LLM reply: one button per incoming (employer) message, drafts a reply into the composer ----

  function getIncomingMessages() {
    return Array.from(document.querySelectorAll('[data-qa^="chatik-chat-message-"]'))
      .map((container) => {
        const messageId = container.getAttribute('data-qa')?.match(INCOMING_MESSAGE_ID_RE)?.[1];
        return messageId ? { container, messageId } : null;
      })
      .filter(Boolean)
      .filter(({ container }) =>
        INCOMING_BUBBLE_CLASS_HINTS.some((hint) => container.querySelector(`[class*="${hint}"]`)),
      );
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

  // ---- shared reactive loop ----

  async function tick() {
    const chatId = currentChatId();
    // the send button only exists once text is typed (see SEND_BUTTON_SELECTOR above), so
    // "can this chat be written to" is decided by the textarea alone
    const hasComposer = Boolean(chatId && document.querySelector(MESSAGE_TEXTAREA_SELECTOR));

    if (hasComposer) injectStyleOnce();
    syncQuickSendButton(chatId, hasComposer);
    await syncSuggestedReplies(chatId, hasComposer);
    syncLlmReplyButtons(hasComposer);
  }

  let tickRunning = false;
  let tickPending = false;
  let contextInvalidated = false;

  // once the extension context is gone there is no recovery path short of reloading the page —
  // stop the observer/poll loop instead of retrying forever and re-failing on every single retry
  function haltOnContextInvalidated() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    domObserver.disconnect();
    clearInterval(fallbackPollId);
    console.warn('💬 [chat-tools] extension was reloaded/updated — reload this page to restore chat tools');
  }

  // leading-edge throttle: runs tick() immediately on the first DOM mutation a chat switch causes,
  // then at most once every TICK_THROTTLE_MS while more mutations keep arriving (hh.ru's own render
  // is not a single mutation, it's a burst), plus one trailing run so whatever mounts last — usually
  // the composer/quick-reply block itself — still gets picked up right after the burst settles.
  // The throttle window is started only once tick() itself has finished (not on call), so two ticks
  // can never run concurrently and race on the same DOM read-then-insert in syncSuggestedReplies.
  function scheduleTick() {
    if (contextInvalidated) return;
    if (tickRunning) {
      tickPending = true;
      return;
    }

    tickRunning = true;
    tick()
      .catch((error) => {
        if (isContextInvalidatedError(error)) {
          haltOnContextInvalidated();
          return;
        }
        return warn(`tick failed: ${error.message}`, error.stack);
      })
      .finally(() => {
        setTimeout(() => {
          tickRunning = false;
          if (tickPending && !contextInvalidated) {
            tickPending = false;
            scheduleTick();
          }
        }, TICK_THROTTLE_MS);
      });
  }

  const domObserver = new MutationObserver(scheduleTick);
  domObserver.observe(document.body, { childList: true, subtree: true });

  // safety net for state changes a DOM mutation might not announce (e.g. a same-document
  // navigation hh.ru's router handles unusually) — sparse enough to cost nothing
  const fallbackPollId = setInterval(scheduleTick, FALLBACK_POLL_INTERVAL_MS);

  scheduleTick();
})();
