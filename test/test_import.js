import assert from 'node:assert';
import { sanitizeRecipeOutput, importRecipe } from '../src/recipeScraperService.js';
import { getDatabase } from '../src/db.js';
import { createServer } from '../src/server.js';

const { inferTags, TAG } = globalThis.RecipeTags;

console.log('--- Starting Recipe Import & Server Hardening Tests ---');

// Tag inference: whole words, not substrings
console.log('Test I1: Tag inference avoids substring false positives...');
{
  const beef = inferTags({ title: 'קציצות בקר ברוטב', ingredients: ['500 גרם בשר טחון', 'בצל'] }, ['צמחוני']);
  assert(!beef.includes(TAG.vegetarian), 'Beef must not be tagged vegetarian (even if the AI said so)');
  assert(!beef.includes(TAG.fish));

  const turkey = inferTags({ title: 'שניצל הודו', ingredients: ['חזה הודו', 'פירורי לחם'] });
  assert(!turkey.includes(TAG.vegetarian), 'Turkey must not be tagged vegetarian');

  const grains = inferTags({ title: 'קערת דגנים', ingredients: ['דגני בוקר', 'חלב'] });
  assert(!grains.includes(TAG.fish), '"דגנים" is grains, not fish');
  assert(grains.includes(TAG.vegetarian));

  const salmon = inferTags({ title: 'סלמון בתנור', ingredients: ['פילה סלמון', 'לימון'] });
  assert(salmon.includes(TAG.fish));
  assert(!salmon.includes(TAG.vegetarian), 'Fish is not vegetarian');

  const prefixed = inferTags({ title: 'פסטה', ingredients: ['והטונה מהקופסה'] });
  assert(prefixed.includes(TAG.fish), 'Hebrew prefixes (ו/ה) should still match');

  const sweet = inferTags({ title: 'עוגה', ingredients: ['2 כוסות סוכר', 'קמח'] }, ['דל סוכר']);
  assert(!sweet.includes(TAG.lowSugar), 'Recipe with sugar must not stay "low sugar"');

  const sugarFree = inferTags({ title: 'ברד', ingredients: ['משקה אנרגיה ללא סוכר'] });
  assert(sugarFree.includes(TAG.lowSugar), '"ללא סוכר" should not count as sugar');

  const cilantro = inferTags({ title: 'סלסה', ingredients: ['עגבנייה', 'כוסברה קצוצה'] }, ['ללא כוסברה']);
  assert(!cilantro.includes(TAG.noCilantro));

  const unknown = inferTags({ title: 'משהו טעים', ingredients: [] });
  assert(!unknown.includes(TAG.vegetarian) && !unknown.includes(TAG.lowSugar),
    'Without ingredients, absence-based tags must not be guessed');
}
console.log('✓ Tag inference passed.');

console.log('Test I2: Import output does not invent nutrition values...');
{
  const out = sanitizeRecipeOutput({ title: 'סלט טונה', ingredients: ['טונה', 'מיונז'], instructions: 'לערבב' });
  assert.strictEqual(out.calories, null);
  assert.strictEqual(out.protein_grams, null);
  assert.strictEqual(out.prep_time_minutes, null);
  assert(out.tags.includes(TAG.fish));
  assert(!out.tags.includes(TAG.noSalads), 'A salad must not be tagged "no salads"');

  const withNumbers = sanitizeRecipeOutput({ title: 'X', ingredients: ['ביצים'], calories: '320', protein_grams: 24.5, prep_time_minutes: 10 });
  assert.strictEqual(withNumbers.calories, 320);
  assert.strictEqual(withNumbers.protein_grams, 24.5);
  assert(withNumbers.tags.includes(TAG.protein));
}
console.log('✓ Nutrition passthrough passed.');

console.log('Test I3: Heuristic (no-AI) import keeps only real text...');
{
  // Clear keys so the heuristic parser runs
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const out = await importRecipe('חביתה\nמצרכים:\n2 ביצים\nמלח\nהכנה:\nלטרוף ולטגן');
  assert.strictEqual(out.title, 'חביתה');
  assert.deepStrictEqual(out.ingredients, ['2 ביצים', 'מלח']);
  assert.deepStrictEqual(out.instructions, ['לטרוף ולטגן']);
  assert.strictEqual(out.calories, null);

  const empty = await importRecipe('רק כותרת');
  assert.deepStrictEqual(empty.ingredients, [], 'No placeholder "מצרך 1"');
}
console.log('✓ Heuristic import passed.');

console.log('Test I4: Server blocks cross-site writes and bad titles...');
{
  const { server } = createServer(getDatabase(':memory:'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const evil = await fetch(`${base}/api/recipes/reset-defaults`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' }
    });
    assert.strictEqual(evil.status, 403, 'Cross-origin POST must be rejected');

    const evilJson = await fetch(`${base}/api/recipes`);
    assert.strictEqual(evilJson.headers.get('access-control-allow-origin'), null, 'No wildcard CORS');

    const sameOrigin = await fetch(`${base}/api/recipes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ title: 'בדיקה' })
    });
    assert.strictEqual(sameOrigin.status, 201, 'Same-origin POST must work');
    const created = await sameOrigin.json();

    const badTitle = await fetch(`${base}/api/recipes/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 123 })
    });
    assert.strictEqual(badTitle.status, 200, 'Non-string title should not crash the server');

    const tagsJs = await fetch(`${base}/recipe-tags.js`);
    assert.strictEqual(tagsJs.status, 200, 'Shared recipe-tags.js must be served to the browser');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
console.log('✓ Server hardening passed.');
console.log('Test I5: Gemini client picks a live model and reports errors clearly...');
{
  await import('../src/public/gemini-client.js');
  const { generate, validateKey, parseJson } = globalThis.GeminiClient;
  const realFetch = globalThis.fetch;
  const calls = [];
  let retired = new Set();
  let overloaded = new Set();
  let schemaBreaks = false;
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), key: init.headers?.['x-goog-api-key'] });
    if (init.headers?.['x-goog-api-key'] === 'bad') {
      return reply(400, { error: { message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } });
    }
    if (String(url).includes('/models?')) {
      const names = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-3.9-flash-preview-01', 'gemini-3.6-flash', 'text-embedding-004']
        .filter(n => !retired.has(n));
      return reply(200, { models: names.map(n => ({ name: `models/${n}`, supportedGenerationMethods: n.startsWith('text') ? ['embedContent'] : ['generateContent'] })) });
    }
    const model = String(url).match(/models\/([^:]+):generateContent/)[1];
    const body = JSON.parse(init.body);
    if (retired.has(model)) return reply(404, { error: { message: 'model not found' } });
    if (overloaded.has(model)) return reply(503, { error: { message: 'The model is overloaded.', status: 'UNAVAILABLE' } });
    if (schemaBreaks && body.generationConfig.responseSchema) return reply(500, { error: { message: 'Internal error encountered.', status: 'INTERNAL' } });
    return reply(200, { candidates: [{ content: { parts: [{ text: `{"model":"${model}","schema":${!!body.generationConfig.responseSchema}}` }] } }] });
  };

  try {
    const ok = await validateKey('good');
    assert.deepStrictEqual(ok, { ok: true, model: 'gemini-3.8-flash' }, 'Newest stable flash (not lite/preview) is chosen');
    assert(calls.every(c => !c.url.includes('key=')), 'Key goes in a header, never the URL');

    const first = parseJson(await generate('good', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], json: true }));
    assert.strictEqual(first.model, 'gemini-3.8-flash');

    retired = new Set(['gemini-3.8-flash']); // model retired mid-session → re-resolve once
    const second = parseJson(await generate('good', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], json: true }));
    assert.strictEqual(second.model, 'gemini-3.6-flash');

    const schema = { type: 'OBJECT', properties: { a: { type: 'STRING' } } };
    const ask = () => generate('good', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], responseSchema: schema });

    overloaded = new Set(['gemini-3.6-flash']); // 503 → next model
    const third = parseJson(await ask());
    assert.strictEqual(third.model, 'gemini-2.5-flash', 'Overloaded model falls back to the next flash model');
    overloaded = new Set();

    schemaBreaks = true; // 500 only when a schema is sent → retry without it
    const fourth = parseJson(await ask());
    assert.strictEqual(fourth.schema, false, 'INTERNAL error with schema retries without schema');
    schemaBreaks = false;

    overloaded = new Set(['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-3.8-flash-lite']);
    await assert.rejects(ask(), err => err.status === 503 && /overloaded/.test(err.message), 'Final error shows Google\'s reason');
    overloaded = new Set();

    const bad = await validateKey('bad');
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /לא תקין/, 'Invalid key gets a clear Hebrew message');

    assert.deepStrictEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  } finally {
    globalThis.fetch = realFetch;
  }
}
console.log('✓ Gemini client passed.');

console.log('Test I6: URL import uses schema.org data and gets past bot-block pages...');
{
  const { extractJsonLdRecipe, isBlockedPage } = globalThis.RecipeTags;
  const recipePage = `<html><head><title>לחמניות</title>
    <meta property="og:image" content="https://site.example/og.jpg">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"x"},
      {"@type":"Recipe","name":"לחמניות קוטג&#039;","description":"רכות","totalTime":"PT1H10M","recipeYield":"18 לחמניות",
       "image":["https://site.example/img.jpg"],"recipeIngredient":["1 קוטג' 5%","2 כוסות קמח"],
       "nutrition":{"calories":"120 kcal","proteinContent":"6 g"},
       "recipeInstructions":[{"@type":"HowToSection","name":"בצק","itemListElement":[{"@type":"HowToStep","text":"מערבבים"}]},
         {"@type":"HowToStep","text":"אופים 25 דקות"}]}]}</script></head><body>${'תוכן '.repeat(400)}</body></html>`;

  const s = extractJsonLdRecipe(recipePage);
  assert.strictEqual(s.title, "לחמניות קוטג'", 'HTML entities decoded');
  assert.deepStrictEqual(s.ingredients, ["1 קוטג' 5%", '2 כוסות קמח']);
  assert.deepStrictEqual(s.instructions, ['בצק:', 'מערבבים', 'אופים 25 דקות'], 'HowToSection flattened');
  assert.strictEqual(s.prep_time_minutes, 70);
  assert.strictEqual(s.calories, 120);
  assert.strictEqual(s.protein_grams, 6);
  assert.strictEqual(s.image_url, 'https://site.example/img.jpg');
  assert.strictEqual(extractJsonLdRecipe('<html>no data</html>'), null);

  const blockPage = '<html><body>Request unsuccessful. Incapsula incident ID: 123</body></html>';
  assert(isBlockedPage(blockPage), 'Incapsula page detected');
  assert(!isBlockedPage(recipePage), 'Real recipe page is not "blocked"');

  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), fmt: init.headers?.['X-Return-Format'] });
    if (String(url).startsWith('https://r.jina.ai/')) return new Response(recipePage, { status: 200 });
    return new Response(blockPage, { status: 200 }); // bot wall with status 200
  };
  try {
    const out = await importRecipe('https://site.example/recipe');
    assert(seen.some(r => r.url.startsWith('https://r.jina.ai/') && r.fmt === 'html'), 'Falls back to reader in HTML mode');
    assert.strictEqual(out.title, "לחמניות קוטג'");
    assert.deepStrictEqual(out.ingredients, ["1 קוטג' 5%", '2 כוסות קמח'], 'Ingredients exactly as the site wrote them');
    assert.strictEqual(out.fromStructuredData, true);
    assert.strictEqual(out.source_url, 'https://site.example/recipe');
    assert.strictEqual(out.calories, 120);

    globalThis.fetch = async () => new Response(blockPage, { status: 200 });
    await assert.rejects(importRecipe('https://blocked.example/r'), /חסם/, 'Blocked everywhere → clear error, not a junk recipe');
  } finally {
    globalThis.fetch = realFetch;
  }
}
console.log('✓ URL import passed.');

console.log('Test I7: Google Keep notes are split into ingredients and steps...');
{
  const { splitIngredient, parseRecipeText } = globalThis.RecipeTags;
  const split = s => { const r = splitIngredient(s); return [r.amount, r.unit, r.name]; };
  assert.deepStrictEqual(split('2 כוסות קמח'), ['2', 'כוסות', 'קמח']);
  assert.deepStrictEqual(split('☐ 1/2 כפית מלח'), ['1/2', 'כפית', 'מלח'], 'Keep checkbox stripped');
  assert.deepStrictEqual(split('1½ כפות שמן זית'), ['1 1/2', 'כפות', 'שמן זית']);
  assert.deepStrictEqual(split('חצי כוס סוכר'), ['1/2', 'כוס', 'סוכר']);
  assert.deepStrictEqual(split('שתי ביצים'), ['2', '', 'ביצים']);
  assert.deepStrictEqual(split('200 גר׳ גבינה בולגרית'), ['200', "גר'", 'גבינה בולגרית']);
  assert.deepStrictEqual(split('200גרם חמאה'), ['200', 'גרם', 'חמאה']);
  assert.deepStrictEqual(split('2-3 שיני שום'), ['2-3', 'שיני', 'שום']);
  assert.deepStrictEqual(split('כף שמן זית'), ['1', 'כף', 'שמן זית']);
  assert.deepStrictEqual(split('קורט מלח'), ['', 'קורט', 'מלח']);
  assert.deepStrictEqual(split('קמח - 2 כוסות'), ['2', 'כוסות', 'קמח']);
  assert.deepStrictEqual(split('ביצים 3'), ['3', '', 'ביצים']);
  assert.deepStrictEqual(split('כוסברה קצוצה'), ['', '', 'כוסברה קצוצה'], '"כוס" inside a word is not a unit');
  assert.deepStrictEqual(split("קוטג' 5%"), ['', '', "קוטג' 5%"], 'Fat % is not an amount');
  assert.deepStrictEqual(split('מלח'), ['', '', 'מלח']);

  // Keep checklist note, no headers at all
  const keepList = parseRecipeText('עוגת שוקולד\n☐ 2 ביצים\n☐ כוס סוכר\n☐ 100 גרם שוקולד מריר\n☐ מלח\nמערבבים את כל החומרים בקערה גדולה.\nאופים 30 דקות ב-180 מעלות.');
  assert.strictEqual(keepList.title, 'עוגת שוקולד');
  assert.deepStrictEqual(keepList.ingredients, ['2 ביצים', 'כוס סוכר', '100 גרם שוקולד מריר', 'מלח']);
  assert.deepStrictEqual(keepList.instructions, ['מערבבים את כל החומרים בקערה גדולה.', 'אופים 30 דקות ב-180 מעלות.']);

  // Headers with emoji / extra words, steps numbered, prep time line, bidi marks
  const withHeaders = parseRecipeText('‏שקשוקה\nזמן הכנה: 25 דקות\n🥚 המצרכים (ל-4 מנות):\n- 4 ביצים\n- 3 עגבניות, בצל, 2 שיני שום\nאופן ההכנה:\n1. מטגנים את הבצל\n2. מוסיפים עגבניות ומבשלים');
  assert.strictEqual(withHeaders.title, 'שקשוקה');
  assert.strictEqual(withHeaders.prep_time_minutes, 25);
  assert.deepStrictEqual(withHeaders.ingredients, ['4 ביצים', '3 עגבניות', 'בצל', '2 שיני שום'], 'Comma list split');
  assert.deepStrictEqual(withHeaders.instructions, ['מטגנים את הבצל', 'מוסיפים עגבניות ומבשלים']);

  // Ingredients header, then steps without a header
  const noStepsHeader = parseRecipeText('סלט\nמצרכים:\nמלפפון\nעגבנייה\nחותכים הכל לקוביות קטנות ומתבלים בשמן זית ולימון');
  assert.deepStrictEqual(noStepsHeader.ingredients, ['מלפפון', 'עגבנייה']);
  assert.deepStrictEqual(noStepsHeader.instructions, ['חותכים הכל לקוביות קטנות ומתבלים בשמן זית ולימון']);

  // "זמן הכנה" is not the instructions header; "קוטג', לבנה או..." stays one ingredient
  const tricky = parseRecipeText("לחמניות\nמצרכים:\nקוטג', לבנה או סימפוניה\nהכנה:\nלערבב");
  assert.deepStrictEqual(tricky.ingredients, ["קוטג', לבנה או סימפוניה"]);
}
console.log('✓ Keep text parsing passed.');
console.log('--- ALL IMPORT TESTS PASSED! ---');
