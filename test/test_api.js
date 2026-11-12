import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase, PREDEFINED_TAGS } from '../src/db.js';
import { syncFromListi, sanitizeWeeklyPlanForHealingCabin } from '../src/integrations.js';

console.log('--- Starting Integration & Schema Tests ---');

// 1. In-memory database initialization
const db = getDatabase(':memory:');

// Test 1: Verify Predefined Tags
console.log('Test 1: Verify Predefined Tags...');
const tagsInDb = db.prepare('SELECT name FROM tags').all().map(r => r.name);
for (const expectedTag of PREDEFINED_TAGS) {
  assert(tagsInDb.includes(expectedTag), `Missing tag: ${expectedTag}`);
}
assert.strictEqual(tagsInDb.length, 8, 'Expected 8 predefined tags');
console.log('✓ All 8 predefined tags initialized properly.');

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

console.log('✓ The Healing Cabin payload strict sanitization passed.');
console.log('--- ALL TESTS PASSED! ---');
