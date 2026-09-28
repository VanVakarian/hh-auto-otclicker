import { installUncaughtErrorCapture } from '../lib/diagnostics.js';
import { startCaptchaGuard } from '../lib/page-watchers.js';
import { onContextInvalidated } from '../lib/extension-context.js';

// Not injected by a page pattern like the other entries: the service worker adds it to a page of the run's
// tab that no entry belongs to (the tab landed there after a submit, and a captcha followed), so that the
// captcha on it can be answered like anywhere else. It looks after the captcha only — the page itself is
// the service worker's to leave again once the captcha is gone.

onContextInvalidated(() => {
  // nothing can be written to the log from a dead context, and a warn here would sit on the Errors page
  console.log('🧷 [stray-page] extension was reloaded/updated — reload this page to restore the bot');
});
installUncaughtErrorCapture('stray-page');
startCaptchaGuard('stray-page');
