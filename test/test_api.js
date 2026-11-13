import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase, PREDEFINED_TAGS } from '../src/db.js';
import { syncFromListi, sanitizeWeeklyPlanForHealingCabin, addMissingIngredientsToListi, pushToHealingCabin } from '../src/integrations.js';
import { calculateRecipeMatches } from '../src/matching.js';
import { seedData } from '../src/seed.js';
import { createServer } from '../src/server.js';

console.log('--- Starting Integration & Schema Tests ---');

// 1. In-memory database initialization
const db = getDatabase(':memory:');

// Test 1: Verify Predefined Tags
console.log('Test 1: Verify Predefined Tags...');
const tagsInDb = db.prepare('SELECT name FROM tags').all().map(r => r.name);
for (const expectedTag of PREDEFINED_TAGS) {
  assert(tagsInDb.includes(expectedTag), `Missing tag: ${expectedTag}`);
}
assert.strictEqual(tagsInDb.length, PREDEFINED_TAGS.length, `Expected ${PREDEFINED_TAGS.length} predefined tags`);
console.log(`✓ All ${PREDEFINED_TAGS.length} predefined tags initialized properly.`);

// Test 2: Recipe Insertion with All Fields
console.log('Test 2: Recipe Insertion with Metadata & Tags...');
const insertRecipe = db.prepare(`
  INSERT INTO recipes (
    title, description, instructions, source_url, image_url,
    prep_time_minutes, calories, protein_grams, difficulty, ingredients, tags
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
insertRecipe.run(
  'סלמון בעשבי תיבול',
  'דג עשיר בחלבון',
  '1. צולים בתנור',
  'https://example.com/salmon',
  'https://example.com/salmon.jpg',
  25,
  350,
  40.5,
  'קל',
  JSON.stringify([{ name: 'סלמון', amount: '200', unit: 'גרם' }]),
  JSON.stringify(['עתיר חלבון', 'מנות דגים (ללא בקר ועוף)', 'ללא כוסברה'])
);

const recipe = db.prepare('SELECT * FROM recipes WHERE title = ?').get('סלמון בעשבי תיבול');
assert(recipe, 'Recipe should be stored');
assert.strictEqual(recipe.calories, 350);
assert.strictEqual(recipe.protein_grams, 40.5);
assert.strictEqual(recipe.difficulty, 'קל');
const parsedTags = JSON.parse(recipe.tags);
assert(parsedTags.includes('עתיר חלבון'));
console.log('✓ Recipe fields and tags verified.');

// Test 3: Listi Integration Webhook
console.log('Test 3: Listi Webhook Ingestion & Status Normalization...');
const listiPayload = [
  { itemName: 'שיבולת שועל', quantity: '500 גרם', status: 'במזווה' },
  { itemName: 'חלב סויה', quantity: '1 ליטר', status: 'missing' }, // should normalize to 'חסר'
  { itemName: 'קינמון', quantity: '1 צנצנת', status: 'shopping_list' } // should normalize to 'ברשימת קניות'
];
const syncResult = syncFromListi(db, listiPayload);
assert.strictEqual(syncResult.synced_count, 3);

const oats = db.prepare('SELECT * FROM pantry_groceries WHERE item_name = ?').get('שיבולת שועל');
assert.strictEqual(oats.status, 'במזווה');

const soyMilk = db.prepare('SELECT * FROM pantry_groceries WHERE item_name = ?').get('חלב סויה');
assert.strictEqual(soyMilk.status, 'חסר');

const cinnamon = db.prepare('SELECT * FROM pantry_groceries WHERE item_name = ?').get('קינמון');
assert.strictEqual(cinnamon.status, 'ברשימת קניות');
console.log('✓ Listi webhook ingestion & normalization passed.');

// Test 4: Weekly Plan Association
console.log('Test 4: Weekly Plan Association...');
const insertPlan = db.prepare(`
  INSERT INTO weekly_plan (day_of_week, meal_type, recipe_id, notes)
  VALUES (?, ?, ?, ?)
`);
insertPlan.run('שני', 'צהריים', recipe.id, 'ארוחת צהריים עתירת חלבון');

const planEntry = db.prepare(`
  SELECT wp.*, r.title AS recipe_title
  FROM weekly_plan wp
  JOIN recipes r ON wp.recipe_id = r.id
  WHERE wp.day_of_week = 'שני' AND wp.meal_type = 'צהריים'
`).get();

assert(planEntry, 'Weekly plan entry should exist');
assert.strictEqual(planEntry.recipe_title, 'סלמון בעשבי תיבול');
console.log('✓ Weekly plan association passed.');

// Test 5: The Healing Cabin Data Sanitization (Security & Strict Payload Check)
console.log('Test 5: The Healing Cabin Payload Strictness...');
const recipesForCabin = [
  {
    id: 1,
    title: 'סלמון בעשבי תיבול',
    description: 'דג עשיר בחלבון',
    instructions: 'סודי ביותר - אסור לחלוק',
    source_url: 'https://secret.com',
    calories: 350,
    protein_grams: 40.5,
    ingredients: JSON.stringify(['רכיב 1', 'רכיב 2'])
  }
];

const sanitized = sanitizeWeeklyPlanForHealingCabin(recipesForCabin);
assert.strictEqual(sanitized.length, 1);
const sanitizedItem = sanitized[0];

// STRICT CHECKS
assert.strictEqual(sanitizedItem.title, 'סלמון בעשבי תיבול');
assert.strictEqual(sanitizedItem.description, 'דג עשיר בחלבון');
assert.strictEqual(sanitizedItem.calories, 350);
assert.strictEqual(sanitizedItem.protein_grams, 40.5);

// Ensure ingredients and instructions are completely omitted
assert.strictEqual(sanitizedItem.instructions, undefined, 'instructions MUST NOT be exposed to The Healing Cabin');
assert.strictEqual(sanitizedItem.ingredients, undefined, 'ingredients MUST NOT be exposed to The Healing Cabin');
assert.strictEqual(sanitizedItem.source_url, undefined, 'source_url MUST NOT be exposed to The Healing Cabin');
assert.strictEqual(sanitizedItem.id, undefined, 'id MUST NOT be exposed');

// Ensure base preps (is_base_prep: true) are omitted from The Healing Cabin
const mixedRecipesForCabin = [
  ...recipesForCabin,
  { id: 99, title: 'טחינה ירוקה', is_base_prep: true, calories: 150, protein_grams: 5 },
  { id: 100, title: 'שום קונפי', day_of_week: 'weekend_prep', calories: 200, protein_grams: 1 }
];
const sanitizedMixed = sanitizeWeeklyPlanForHealingCabin(mixedRecipesForCabin);
assert.strictEqual(sanitizedMixed.length, 1, 'Base Preps must be strictly omitted from The Healing Cabin payload');

console.log('✓ The Healing Cabin payload strict sanitization passed.');

// Test 6: Multi-tag AND filtering
console.log('Test 6: Multi-tag AND filtering...');
insertRecipe.run(
  'גלידת חלבון נינג\'ה קרימי',
  'מתכון לנינג\'ה',
  'ערבב והקפא',
  'https://example.com/icecream',
  '',
  5,
  180,
  30,
  'קל',
  '[]',
  JSON.stringify(['עתיר חלבון', 'מתאים לנינג\'ה קרימי', 'דל סוכר'])
);

const all = db.prepare('SELECT * FROM recipes').all();
const matchBoth = all.filter(r => {
  const t = JSON.parse(r.tags || '[]');
  return ['עתיר חלבון', 'מתאים לנינג\'ה קרימי'].every(tag => t.includes(tag));
});
assert.strictEqual(matchBoth.length, 1);
assert.strictEqual(matchBoth[0].title, 'גלידת חלבון נינג\'ה קרימי');
console.log('✓ Multi-tag AND filtering passed.');

// Test 7: Matching Algorithm (What Can I Cook)
console.log('Test 7: Matching Algorithm (100% vs Missing)...');

// Recipe with 2 ingredients
insertRecipe.run(
  'שייק חלבון ופירות יער',
  'שייק קל ומהיר',
  'לערבב בבלנדר',
  '',
  '',
  3,
  150,
  25,
  'קל',
  JSON.stringify([
    { name: 'אבקת חלבון וניל', amount: '1', unit: 'סקופ' },
    { name: 'פירות יער קפואים', amount: '100', unit: 'גרם' }
  ]),
  JSON.stringify(['עתיר חלבון', 'דל סוכר'])
);

// We have 'שיבולת שועל', 'סלמון' in pantry ('במזווה'), but not 'פירות יער קפואים'
const currentPantry = db.prepare('SELECT * FROM pantry_groceries').all();
const testRecipes = db.prepare('SELECT * FROM recipes').all();
const scored = calculateRecipeMatches(testRecipes, currentPantry);

assert(scored.length >= 3, 'Should score all recipes');
// Salmon has 1 ingredient 'סלמון' which is matched or let's inspect match percentage
const salmonRecipe = scored.find(r => r.title === 'סלמון בעשבי תיבול');
assert(salmonRecipe, 'Salmon recipe should be scored');

// Test 8: Quick-add to Listi shopping cart
console.log('Test 8: Quick-add Missing Ingredients to Listi...');
const missingItemsToAdd = [{ name: 'פירות יער קפואים', amount: '100', unit: 'גרם' }];
const addResult = await addMissingIngredientsToListi(db, missingItemsToAdd);
assert.strictEqual(addResult.status, 'success');

const berries = db.prepare('SELECT * FROM pantry_groceries WHERE item_name = ?').get('פירות יער קפואים');
assert(berries, 'Berries should be inserted into pantry_groceries');
assert.strictEqual(berries.status, 'ברשימת קניות', 'Status should be shopping list');
console.log('✓ Quick-add to Listi shopping list passed.');

// Test 9 & 10: HTTP Server Static Assets, Scrape Validation & Recipe CRUD + Weekly Plan
console.log('Test 9-10: HTTP Server Static Assets, Scrape Validation & Recipe CRUD...');
const httpDb = getDatabase(':memory:');
seedData(httpDb);
const { server } = createServer(httpDb);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  for (const assetPath of ['/manifest.json', '/sw.js', '/icons/icon.svg']) {
    const res = await fetch(`${baseUrl}${assetPath}`);
    assert.strictEqual(res.status, 200, `${assetPath} should return 200`);
  }

  const scrapeBadRes = await fetch(`${baseUrl}/api/recipes/scrape?url=`);
  assert.strictEqual(scrapeBadRes.status, 400, 'Empty scrape url should return 400');

  const createRes = await fetch(`${baseUrl}/api/recipes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'בדיקת מתכון זמני',
      description: 'תיאור',
      instructions: '1. ערבוב',
      calories: 320,
      protein_grams: 28,
      ingredients: [{ name: 'טופו', amount: '150', unit: 'גרם' }],
      tags: ['עתיר חלבון', 'צמחוני']
    })
  });
  assert.strictEqual(createRes.status, 201);
  const created = await createRes.json();
  assert(Number.isInteger(created.id) && created.id > 0);

  const updateRes = await fetch(`${baseUrl}/api/recipes/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'בדיקת מתכון מעודכן', calories: 350 })
  });
  assert.strictEqual(updateRes.status, 200);
  const updated = await updateRes.json();
  assert.strictEqual(updated.title, 'בדיקת מתכון מעודכן');
  assert.strictEqual(updated.calories, 350);

  const assignRes = await fetch(`${baseUrl}/api/weekly-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      day_of_week: 'ראשון',
      meal_type: 'ביניים אחה"צ',
      recipe_id: created.id
    })
  });
  assert.strictEqual(assignRes.status, 200);

  const planRes = await fetch(`${baseUrl}/api/weekly-plan`);
  assert.strictEqual(planRes.status, 200);
  const planRows = await planRes.json();
  const snackSlot = planRows.find(s => s.day_of_week === 'ראשון' && s.meal_type === 'ביניים אחה"צ');
  assert(snackSlot, 'Afternoon snack slot should be stored');
  assert.strictEqual(snackSlot.title, 'בדיקת מתכון מעודכן');
  assert('image_url' in snackSlot && 'is_base_prep' in snackSlot, 'Weekly plan should expose image_url and is_base_prep');

  const delRes = await fetch(`${baseUrl}/api/recipes/${created.id}`, { method: 'DELETE' });
  assert.strictEqual(delRes.status, 200);

  const afterDelPlan = await (await fetch(`${baseUrl}/api/weekly-plan`)).json();
  assert(!afterDelPlan.some(s => s.recipe_id === created.id), 'Deleting recipe should cascade from weekly_plan');

  // Test 11: seedData must not resurrect deleted recipes unless force=true
  console.log('Test 11: seedData deletion persistence & force reset...');
  const countBeforeReseed = httpDb.prepare('SELECT COUNT(*) as c FROM recipes').get().c;
  httpDb.prepare('DELETE FROM recipes WHERE id = (SELECT id FROM recipes LIMIT 1)').run();
  const countAfterDelete = httpDb.prepare('SELECT COUNT(*) as c FROM recipes').get().c;
  assert.strictEqual(countAfterDelete, countBeforeReseed - 1);
  seedData(httpDb);
  assert.strictEqual(httpDb.prepare('SELECT COUNT(*) as c FROM recipes').get().c, countAfterDelete, 'seedData should not resurrect deleted recipes');
  seedData(httpDb, true);
  assert.strictEqual(httpDb.prepare('SELECT COUNT(*) as c FROM recipes').get().c, countBeforeReseed, 'seedData(db, true) should restore defaults');

  // Test 12: pushToHealingCabin updates temp plansDB.json including afternoonSnack
  console.log('Test 12: pushToHealingCabin plansDB.json sync...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cabin-test-'));
  const tmpPlansPath = path.join(tmpDir, 'plansDB.json');
  fs.writeFileSync(tmpPlansPath, JSON.stringify({
    weeklyPlan: [
      {
        dayName: 'ראשון',
        nutrition: {
          targetCalories: 0,
          targetProteinGrams: 0,
          meals: {
            breakfast: { name: 'old', calories: 0, proteinGrams: 0 },
            morningSnack: { name: 'old', calories: 0, proteinGrams: 0 },
            lunch: { name: 'old', calories: 0, proteinGrams: 0 },
            afternoonSnack: { name: 'old', calories: 0, proteinGrams: 0 },
            dinner: { name: 'old', calories: 0, proteinGrams: 0 }
          }
        }
      }
    ]
  }, null, 2));

  try {
    const pushOut = await pushToHealingCabin(
      [
        { day_of_week: 'ראשון', meal_type: 'ביניים אחה"צ', title: 'יוגורט חלבון ואגוזים', calories: 220, protein_grams: 20, description: 'חטיף מזין' },
        { day_of_week: 'ראשון', meal_type: 'צהריים', title: 'סלמון צלוי', calories: 450, protein_grams: 42, description: '' }
      ],
      undefined,
      tmpPlansPath
    );
    assert.strictEqual(pushOut.status, 'success');
    assert.strictEqual(pushOut.updatedMeals, 2);
    const savedPlans = JSON.parse(fs.readFileSync(tmpPlansPath, 'utf8'));
    const sundayMeals = savedPlans.weeklyPlan[0].nutrition.meals;
    assert.strictEqual(sundayMeals.afternoonSnack.name, 'יוגורט חלבון ואגוזים');
    assert.strictEqual(sundayMeals.lunch.name, 'סלמון צלוי');
    assert.strictEqual(savedPlans.weeklyPlan[0].nutrition.targetCalories, 670);
    assert.strictEqual(savedPlans.weeklyPlan[0].nutrition.targetProteinGrams, 62);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}

console.log('✓ HTTP & integration tests passed.');
console.log('--- ALL TESTS PASSED! ---');
