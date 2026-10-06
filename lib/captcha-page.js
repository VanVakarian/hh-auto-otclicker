import {
  CAPTCHA_PICTURE_SELECTOR,
  CAPTCHA_INPUT_SELECTOR,
  CAPTCHA_DIALOG_SELECTOR,
  CAPTCHA_LANGUAGE_SELECTOR,
  CAPTCHA_SUBMIT_SELECTORS,
} from './hh-pages.js';
import { isVisible } from './dom.js';
import { hashText } from './hash.js';

// What hh.ru's captcha dialog shows right now — read by the watcher (which archives and describes it) and
// by the auto-solver (which answers it). The describe* functions turn the page into one loggable line each:
// what a diagnostic entry needs to say about the dialog when something has gone wrong with it.

const ERROR_SELECTOR = '[data-qa="account-captcha-error"]';
// the captcha dialog is an ordinary modal-overlay, same as the response popup
const MODAL_OVERLAY_SELECTOR = '[data-qa="modal-overlay"]';
const RESPONSE_SUBMIT_SELECTOR = '[data-qa="vacancy-response-submit-popup"]';
const BUTTON_TEXT_LENGTH = 20;

// the picture's id in hh.ru's URL — tells one captcha from the next; null while there is no picture
export function pictureKey() {
  try {
    return new URL(document.querySelector(CAPTCHA_PICTURE_SELECTOR).src).searchParams.get('key');
  } catch {
    return null; // no picture (yet) — the input alone was enough to see the dialog
  }
}

// The picture as a PNG data URL together with its key and size, or null while it hasn't finished loading.
// Throws if the browser refuses to export it (a picture served without CORS headers taints the canvas).
export function readPicture() {
  const picture = document.querySelector(CAPTCHA_PICTURE_SELECTOR);
  const key = pictureKey();
  if (!picture || !key || !picture.complete || picture.naturalWidth === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = picture.naturalWidth;
  canvas.height = picture.naturalHeight;
  canvas.getContext('2d').drawImage(picture, 0, 0);
  return { key, dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

function captchaDialog() {
  return document.querySelector(CAPTCHA_INPUT_SELECTOR)?.closest(CAPTCHA_DIALOG_SELECTOR) ?? null;
}

// The dialog's submit button has no data-qa of its own. It is looked for only inside the dialog that
// holds the captcha input, so a submit button of some other dialog (the response popup's) is never taken.
// Template variants that lack the usual type="submit" button fall back to the modal footer's last button.
export function submitButton() {
  const dialog = captchaDialog();
  if (!dialog) return null;
  for (const selector of CAPTCHA_SUBMIT_SELECTORS) {
    const button = dialog.querySelector(selector);
    if (button) return button;
  }
  return null;
}

// The language button offers the other language, so it reads "English" while the picture is Russian. Its
// absence is no reason to doubt: Russian is what hh.ru serves by default.
export function isRussianCaptcha() {
  const toggle = document.querySelector(CAPTCHA_LANGUAGE_SELECTOR);
  return !toggle || toggle.textContent.trim() === 'English';
}

// hh.ru's own "Неверный текст" state
export function isErrorShown() {
  const container = document.querySelector(ERROR_SELECTOR)?.closest('[aria-hidden]');
  return container?.getAttribute('aria-hidden') === 'false';
}

// What the dialog looks like right now, as fields. `key` is the picture's id (whole), `errorShown` is hh.ru's
// own "Неверный текст" state — together with the page activity log they show whether an error came from a
// wrong answer or arrived with the dialog.
export function captchaState() {
  const input = document.querySelector(CAPTCHA_INPUT_SELECTOR);
  const responseSubmit = document.querySelector(RESPONSE_SUBMIT_SELECTOR);

  return {
    key: pictureKey(),
    errorShown: isErrorShown(),
    inputInvalid: input?.getAttribute('aria-invalid') === 'true',
    inputLen: input?.value.length ?? null,
    overlays: document.querySelectorAll(MODAL_OVERLAY_SELECTOR).length,
    responseSubmit: responseSubmit ? (responseSubmit.disabled ? 'disabled' : 'enabled') : 'absent',
  };
}

// the same as one loggable line
export function describeCaptcha() {
  const state = captchaState();
  return (
    `key=${state.key?.slice(0, 8) ?? 'none'} errorShown=${state.errorShown} inputInvalid=${state.inputInvalid} ` +
    `inputLen=${state.inputLen ?? 'n/a'} overlays=${state.overlays} responseSubmit=${state.responseSubmit}`
  );
}

// Every button of the captcha dialog with its state — what to read when the submit button (or the "another
// text" one) was not found, was disabled, or was pressed to no effect: shows whether hh.ru changed the markup.
export function describeDialogControls() {
  const dialog = captchaDialog();
  if (!dialog) return 'dialog=not found around the input';

  const buttons = [...dialog.querySelectorAll('button')].map((button) => {
    const text = button.textContent.replace(/\s+/g, ' ').trim().slice(0, BUTTON_TEXT_LENGTH);
    const name = button.getAttribute('data-qa') ?? button.getAttribute('aria-label') ?? '-';
    return `[${button.type} ${button.disabled ? 'disabled' : 'enabled'} qa=${name} "${text}"]`;
  });
  return `dialog buttons: ${buttons.join(' ') || 'none'}`;
}

// The picture element's state — what to read when a captcha stays unanswered because the picture never
// became readable (still loading, broken, no key in its address).
export function describePicture() {
  const picture = document.querySelector(CAPTCHA_PICTURE_SELECTOR);
  if (!picture) return 'picture=absent';
  return (
    `picture: visible=${isVisible(picture)} complete=${picture.complete} ` +
    `size=${picture.naturalWidth}x${picture.naturalHeight} key=${pictureKey()?.slice(0, 8) ?? 'none'}`
  );
}

// An element as one short token: its tag with the parts that identify it in hh.ru's markup
function elementToken(element) {
  if (!element) return 'none';
  const parts = [
    ['qa', element.getAttribute('data-qa')],
    ['role', element.getAttribute('role')],
    ['form', element.getAttribute('form')],
  ];
  return element.tagName.toLowerCase() + parts.map(([name, value]) => (value ? `[${name}=${value}]` : '')).join('');
}

// the identifying elements from the page's root down to this one: the shape of the markup around it
function ancestorChain(element) {
  const chain = [];
  for (let node = element; node && node !== document.body; node = node.parentElement) {
    if (node === element || node.hasAttribute('data-qa') || node.hasAttribute('role') || node.tagName === 'FORM') {
      chain.push(elementToken(node));
    }
  }
  return chain.reverse().join(' > ');
}

// What the captcha's markup looks like, as fields: hh.ru serves different templates to different accounts and
// experiments, and the difference between "the button worked" and "it did not" is often in the structure
// (a form around the input or none, a response popup under the dialog or none). `fingerprint` is the same
// shape as one short value, to group episodes by template without reading the chains.
export function captchaStructure() {
  const dialog = captchaDialog();
  const button = submitButton();
  const chains = {
    input: ancestorChain(document.querySelector(CAPTCHA_INPUT_SELECTOR)),
    picture: ancestorChain(document.querySelector(CAPTCHA_PICTURE_SELECTOR)),
    submit: ancestorChain(button),
  };
  const dialogQa = dialog
    ? [...new Set([...dialog.querySelectorAll('[data-qa]')].map((element) => element.getAttribute('data-qa')))]
    : [];
  return {
    ...chains,
    dialogQa,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    forms: document.querySelectorAll('form').length,
    submitHasForm: button ? Boolean(button.form) : null,
    fingerprint: hashText(`${chains.input}|${chains.submit}|${dialogQa.join(',')}`),
  };
}

// Whether the submit button can be pressed and what is around the press — the facts that tell a press that
// reached the button from one that did not: the button's own state, what is on top of it at its centre
// (something covering it takes the click), where the focus is (a field that never lost focus, a tab no one
// looks at), and the page's own flags for the dialog.
export function pressState() {
  const button = submitButton();
  const input = document.querySelector(CAPTCHA_INPUT_SELECTOR);
  const active = document.activeElement;
  const state = {
    tabFocused: document.hasFocus(),
    visibility: document.visibilityState,
    active: elementToken(active === document.body ? null : active),
    inputFocused: Boolean(input) && active === input,
    inputLen: input?.value.length ?? null,
  };
  if (!button) return { ...state, button: 'absent' };

  const rect = button.getBoundingClientRect();
  const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return {
    ...state,
    button: elementToken(button),
    disabled: button.disabled,
    ariaDisabled: button.getAttribute('aria-disabled'),
    rect: `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`,
    inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
    top: top && !button.contains(top) ? elementToken(top) : 'button',
    hasForm: Boolean(button.form),
  };
}
