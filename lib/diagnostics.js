import { addDiagnosticLogEntry } from './storage.js';
import { isContextInvalidatedError } from './extension-context.js';

// chrome://extensions → Errors collects EVERYTHING the extension writes with console.warn or
// console.error, not just crashes — so a situation the bot handles as part of normal work (a popup that
// refused, a captcha, an LLM model that didn't answer) would sit there as a red badge forever. This
// module is where such situations go instead: the diagnostic log gets the structured entry, the console
// gets a plain console.log line, and nothing lands on the Errors page. Two doors:
//  - reportWarning / reportError: handled situations, the only way this extension reports one;
//  - installUncaughtErrorCapture: the net for what nobody handled (a thrown error, a rejected promise
//    nobody awaited) — those still show on the Errors page, because the browser reports them itself,
//    and get a diagnostic entry too, so the page never shows something the log doesn't know about.
// Direct console.warn / console.error calls are therefore not used anywhere else in the extension.

const CONSOLE_PREFIXES = {
  background: '🧠 [background]',
  list: '📋 [list]',
  questionnaire: '📝 [questionnaire]',
  'chat-tools': '💬 [chat-tools]',
  'search-tracker': '🔎 [search-tracker]',
  llm: '🤖 [llm]',
  captcha: '🧩 [captcha]',
  'stray-page': '🧷 [stray-page]',
  settings: '⚙️ [settings]',
  'run-view': '🖥️ [run-view]',
  'run-control': '⏸️ [run-control]',
  upload: '📤 [upload]',
};

const STACK_LINES = 12;

// Must never throw: it runs from catch blocks and global error handlers, where a failure of its own
// would replace the original error with a confusing one about the logger. A dead extension context
// (reloaded mid-run) can't write anything — the console line is all that's left then, and it is expected.
function writeEntry(level, module, message, context, data) {
  return addDiagnosticLogEntry({ at: Date.now(), level, module, message, context, data }).catch((error) => {
    if (isContextInvalidatedError(error)) return;
    // the log itself being unwritable (quota, storage failure) is a real fault worth the Errors page
    console.error(`${CONSOLE_PREFIXES[module] ?? module} diagnostic write failed: ${error.message}`);
  });
}

function report(level, module, message, context, data) {
  console.log(`${CONSOLE_PREFIXES[module] ?? `[${module}]`} ${message}${context ? ` (${context})` : ''}`);
  return writeEntry(level, module, message, context, data);
}

// `data`: the same facts as fields of an object, for analysis by program (see addTraceEntry)
export function reportWarning(module, message, context, data) {
  return report('warn', module, message, context, data);
}

export function reportError(module, message, context, data) {
  return report('error', module, message, context, data);
}

// the top of an error's stack on one line — where it was thrown, without the rest of the log's bulk
export function stackOf(error) {
  return (error?.stack || '').split('\n').slice(0, STACK_LINES).join(' | ');
}

function describeThrown(thrown) {
  if (thrown instanceof Error) return { message: `${thrown.name}: ${thrown.message}`, stack: stackOf(thrown) };
  return { message: `non-Error thrown: ${String(thrown).slice(0, 300)}`, stack: '' };
}

// RunStoppedError is the run's own "stopped while waiting" unwind (see run-control) and a dead
// extension context can't be logged — neither is a fault worth an entry
function isExpected(thrown) {
  return thrown?.name === 'RunStoppedError' || isContextInvalidatedError(thrown);
}

// The handlers only see this context's own scripts: a page's errors never reach a content script's
// isolated world, so what is captured here is always this extension's.
let captureInstalled = false;

export function installUncaughtErrorCapture(module) {
  // several entry modules can share one isolated world (SPA navigation injects the next one into the same
  // document) — one pair of handlers per world, or every error would be logged once per entry
  if (captureInstalled) return;
  captureInstalled = true;

  globalThis.addEventListener('error', (event) => {
    const thrown = event.error ?? event.message;
    if (isExpected(thrown)) return;
    const { message, stack } = describeThrown(thrown);
    writeEntry('error', module, `uncaught: ${message}`, `${event.filename}:${event.lineno}:${event.colno} ${stack}`);
  });

  globalThis.addEventListener('unhandledrejection', (event) => {
    if (isExpected(event.reason)) return;
    const { message, stack } = describeThrown(event.reason);
    writeEntry('error', module, `unhandled rejection: ${message}`, stack);
  });
}
