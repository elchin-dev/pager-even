import assert from 'node:assert/strict'
import test from 'node:test'
import { stripUnsupportedLensChars, toLens, toOriginalLens, translit } from '../src/lib/translit.js'

test('translit converts Russian Cyrillic accurately', () => {
  assert.equal(translit('Привет, Азиз!'), 'Privet, Aziz!')
  assert.equal(translit('Щука и ёжик, подъезд, объявление'), 'Shchuka i yozhik, podezd, obyavlenie')
  assert.equal(translit('Юля и Яна в центре'), 'Yulya i Yana v tsentre')
})

test('translit converts Uzbek Cyrillic and normalizes Uzbek apostrophes', () => {
  assert.equal(translit('Ўзбекистон, ғишт, қоғоз, ҳаво'), "O'zbekiston, g'isht, qog'oz, havo")
  assert.equal(translit('Ғолиб Ўктам Қодир Ҳасан'), "G'olib O'ktam Qodir Hasan")
  assert.equal(translit('Oʻzbekiston, gʻolib — 100%'), "O'zbekiston, g'olib - 100%")
})

test('toLens strips unsupported characters, collapses whitespace, and truncates with ellipsis', () => {
  assert.equal(stripUnsupportedLensChars('Hi 🔥🚀 мир!'), 'Hi  !')
  assert.equal(toLens('Привет 🔥  мир!\nКак дела?', 40), 'Privet mir! Kak dela?')
  assert.equal(toLens('Азиз Каримов', 12), 'Aziz Karimov')

  const truncated = toLens('Очень длинное сообщение для экрана очков G2', 16)
  assert.ok(truncated.length <= 16)
  assert.ok(truncated.endsWith('…'))
  assert.equal(truncated, 'Ochen dlinnoe s…')

  assert.equal(toLens('Hello', 1), '…')
  assert.equal(toLens('Hello', 0), '')
})

test('toOriginalLens preserves Cyrillic and Unicode emojis without breaking surrogate pairs', () => {
  assert.equal(toOriginalLens('Привет 👍🔥❤️', 32), 'Привет 👍🔥❤️')
  const sliced = toOriginalLens('Ок 👍😂🔥', 5)
  assert.equal(sliced, 'Ок 👍…')
})
