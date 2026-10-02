import {
  CAPTCHA_PICTURE_SELECTOR,
  CAPTCHA_INPUT_SELECTOR,
  CAPTCHA_DIALOG_SELECTOR,
  CAPTCHA_LANGUAGE_SELECTOR,
} from './hh-pages.js';
import { isVisible } from './dom.js';

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
export function submitButton() {
  return captchaDialog()?.querySelector('button[type="submit"]') ?? null;
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
