import { solveCaptcha } from './captcha-solver.js';
import { addTraceEntry } from './storage.js';

// A check of the whole captcha path that needs no live captcha: a picture is drawn (words along an arc over
// a noisy background — a simplified likeness of hh.ru's), sent through the very same solver the bot uses,
// and the answer is compared with what was drawn. It shows whether the key, the credits, the model (does it
// take images at all) and the reply parsing work, before the first real captcha finds out the hard way.
// The drawing is simpler than the real thing, so a slightly different reading is not a failure.

// without ё, which a reader may legitimately give as е
const WORDS = ['ветреный берег', 'тихая гавань', 'старый маяк', 'горная тропа', 'ночной дозор', 'зимний вечер'];

const WIDTH = 250;
const HEIGHT = 90;
const RADIUS = 105;
const NOISE_SPOTS = 260;

function drawCaptcha(text) {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d');

  context.fillStyle = '#8c8c8c';
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = 'rgba(0, 0, 0, 0.22)'; // the diagonal shade
  context.beginPath();
  context.moveTo(0, HEIGHT);
  context.lineTo(WIDTH, 0);
  context.lineTo(WIDTH, HEIGHT);
  context.fill();
  for (let i = 0; i < NOISE_SPOTS; i += 1) {
    context.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'}, ${Math.random() * 0.18})`;
    context.fillRect(Math.random() * WIDTH, Math.random() * HEIGHT, 2 + Math.random() * 6, 2 + Math.random() * 6);
  }

  // every letter stands on the arc, turned to follow it
  context.font = 'bold 24px serif';
  context.fillStyle = '#111';
  context.textAlign = 'center';
  const letters = [...text];
  const widths = letters.map((letter) => context.measureText(letter).width);
  let angle = -widths.reduce((total, width) => total + width, 0) / RADIUS / 2;
  letters.forEach((letter, index) => {
    angle += widths[index] / RADIUS / 2;
    context.save();
    context.translate(WIDTH / 2 + RADIUS * Math.sin(angle), HEIGHT + 50 - RADIUS * Math.cos(angle));
    context.rotate(angle);
    context.fillText(letter, 0, 0);
    context.restore();
    angle += widths[index] / RADIUS / 2;
  });

  return canvas.toDataURL('image/png');
}

const normalize = (text) => text.toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();

// Resolves to what the settings screen shows: { ok, matched, expected, answer, error, model, ms, cost }.
// `ok` — the call worked and produced an answer; `matched` — the answer is what was drawn.
export async function runSolverSelfTest(settings) {
  const expected = WORDS[Math.floor(Math.random() * WORDS.length)];
  const startedAt = Date.now();
  const response = await solveCaptcha({
    apiKey: settings.apiKey,
    model: settings.captchaModel,
    dataUrl: drawCaptcha(expected),
  });

  const result = {
    ok: response.success,
    matched: response.success && normalize(response.answer) === normalize(expected),
    expected,
    answer: response.answer ?? null,
    error: response.error ?? null,
    kind: response.kind ?? null,
    model: response.metadata?.servedModel ?? response.metadata?.model ?? null,
    ms: Date.now() - startedAt,
    cost: response.metadata?.cost ?? null,
  };

  await addTraceEntry(
    'captcha',
    'solver self-test',
    `ok=${result.ok} matched=${result.matched} expected="${expected}" answer="${result.answer ?? '-'}" ` +
      `model=${result.model ?? '-'} ms=${result.ms} cost=${result.cost ?? 'n/a'} kind=${result.kind ?? '-'} ` +
      `tokens=${response.metadata?.tokens ?? '-'} finish=${response.metadata?.finishReason ?? '-'}` +
      `${result.error ? ` error="${result.error.replace(/\s+/g, ' ').slice(0, 200)}"` : ''}`,
  );
  return result;
}
