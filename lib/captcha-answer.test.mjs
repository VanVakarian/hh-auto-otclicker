// node --test lib/captcha-answer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAnswer, transcriptOf, agreesWithTranscript } from './captcha-answer.js';

test('extractAnswer', async (t) => {
  const cases = [
    ['plain marker', 'ANSWER: восхи укладисто', 'восхи укладисто'],
    ['working before the marker is ignored', 'в о с х и\nу к л а д и с т о\nANSWER: восхи укладисто', 'восхи укладисто'],
    ['the last marker wins', 'ANSWER: раз два\nпоправка\nANSWER: три четыре', 'три четыре'],
    ['marker case and spacing', 'answer:   Благу   Смиришься  ', 'благу смиришься'],
    ['answer on the line after the marker', 'ANSWER:\nпучит сгущенное', 'пучит сгущенное'],
    ['markdown and quotes are stripped', '**ANSWER:** «домбра» "непутево"', 'домбра непутево'],
    ['trailing punctuation is stripped', 'ANSWER: выращенной беты.', 'выращенной беты'],
    ['ё is kept', 'ANSWER: ёлка стоит', 'ёлка стоит'],
    ['hyphenated word', 'ANSWER: кто-то стоит', 'кто-то стоит'],
    ['one word', 'ANSWER: люка', 'люка'],
    ['four words', 'ANSWER: раз два три четыре', 'раз два три четыре'],
    ['no marker', 'восхи укладисто', null],
    ['empty marker', 'ANSWER:', null],
    ['null content', null, null],
    ['latin letters', 'ANSWER: voshi ukladisto', null],
    ['digits', 'ANSWER: восхи 123', null],
    ['mixed alphabets inside a word', 'ANSWER: восxи укладисто', null],
    ['five words', 'ANSWER: раз два три четыре пять', null],
    ['a sentence with punctuation inside', 'ANSWER: я не могу, извините', null],
    ['too long', `ANSWER: ${'а'.repeat(61)}`, null],
  ];

  for (const [name, content, expected] of cases) {
    await t.test(name, () => assert.equal(extractAnswer(content), expected));
  }
});

// the replies are real ones from the diagnostic log of 01.10.2026
test('the transcription and whether the answer agrees with it', async (t) => {
  const cases = [
    ['agrees', 'п о м е т к у з а о х а т ь ANSWER: пометку заохать', 'пометкузаохать', true],
    ['mixed case is read as lowercase', 'Льщу засеваютсЯ ANSWER: льщу засеваются', 'льщузасеваются', true],
    ['ё is a letter of its own', 'Д у б л ё р а л е ж а н и и ANSWER: дублёра лежании', 'дублёралежании', true],
    ['the answer corrected the reading', 'о б ъ я в л е н и й з ё в е ANSWER: объявления зёве', 'объявленийзёве', false],
    ['one letter differs', 'о б о и м р а з ъ е в ш е е ANSWER: обойм разъевшее', 'обоимразъевшее', false],
  ];

  for (const [name, content, transcript, agrees] of cases) {
    await t.test(name, () => {
      assert.equal(transcriptOf(content), transcript);
      assert.equal(agreesWithTranscript(transcriptOf(content), extractAnswer(content)), agrees);
    });
  }

  await t.test('nothing before the marker', () => {
    assert.equal(transcriptOf('ANSWER: домбра'), null);
    assert.equal(agreesWithTranscript(null, 'домбра'), null);
  });
  await t.test('no marker, no content', () => {
    assert.equal(transcriptOf('просто текст'), null);
    assert.equal(transcriptOf(null), null);
  });
  await t.test('latin letters and punctuation are not letters of the reading', () => {
    assert.equal(transcriptOf('Transcription: д о м б р а. ANSWER: домбра'), 'домбра');
  });
});
