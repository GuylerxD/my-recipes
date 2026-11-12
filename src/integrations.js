/**
 * Integration services for Listi and The Healing Cabin
 */

/**
 * Normalizes input status to one of the 3 allowed values:
 * 'במזווה', 'חסר', 'ברשימת קניות'
 */
export function normalizePantryStatus(rawStatus) {
  if (!rawStatus) return 'במזווה';
  const s = String(rawStatus).trim().toLowerCase();
  if (s === 'במזווה' || s === 'in_stock' || s === 'pantry' || s === 'available') {
    return 'במזווה';
  }
  if (s === 'חסר' || s === 'out_of_stock' || s === 'missing') {
    return 'חסר';
  }
  if (s === 'ברשימת קניות' || s === 'רשימת קניות' || s === 'shopping_list' || s === 'grocery_list') {
    return 'ברשימת קניות';
  }
  return 'במזווה';
}

/**
 * Ingest inventory / groceries batch or item from Listi
 */
export function syncFromListi(db, payload) {
  const items = Array.isArray(payload) ? payload : (payload.items || [payload]);
  const upsertStmt = db.prepare(`
    INSERT INTO pantry_groceries (item_name, quantity, status, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(item_name) DO UPDATE SET
      quantity = excluded.quantity,
      status = excluded.status,
      updated_at = CURRENT_TIMESTAMP
  `);

  const results = [];
  for (const item of items) {
    const itemName = item.itemName || item.name || item.item_name;
    if (!itemName) continue;

    const quantity = String(item.quantity ?? item.amount ?? '1');
    const status = normalizePantryStatus(item.status);

    upsertStmt.run(itemName, quantity, status);
    results.push({ item_name: itemName, quantity, status });
  }

  return {
    synced_count: results.length,
    items: results
  };
}

/**
 * Prepares the sanitized payload for 'The Healing Cabin'
 * Strictly includes ONLY: title, description, calories, protein
 * Excludes: ingredients, instructions, source URLs, etc.
 */
export function sanitizeWeeklyPlanForHealingCabin(recipes) {
  return recipes.map(r => {
    const item = {
      title: r.title,
      description: r.description || '',
      calories: Number(r.calories) || 0,
      protein_grams: Number(r.protein_grams) || 0
    };
    if (r.day_of_week) item.day_of_week = r.day_of_week;
    if (r.meal_type) item.meal_type = r.meal_type;
    return item;
  });
}

/**
 * Pushes approved weekly plan recipes to The Healing Cabin
 */
export async function pushToHealingCabin(recipes, destinationUrl = process.env.THE_HEALING_CABIN_URL) {
  const sanitizedRecipes = sanitizeWeeklyPlanForHealingCabin(recipes);
  const payload = {
    source: 'NutritionRecipePlanner',
    event: 'WEEKLY_PLAN_APPROVED',
    timestamp: new Date().toISOString(),
    recipes: sanitizedRecipes
  };

  if (!destinationUrl) {
    // Simulated successful push when external URL is not yet bound
    return {
      status: 'simulated_success',
      message: 'No external URL configured; validated sanitized payload ready for delivery.',
      payload
    };
  }

  const response = await fetch(destinationUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'NutritionPlanner/1.0'
    },
    body: JSON.stringify(payload)
  });

  return {
    status: response.ok ? 'success' : 'failed',
    statusCode: response.status,
    payload
  };
}

import { pushItemsToListi } from './listiClient.js';

/**
 * Pushes missing recipe ingredients directly to Listi shopping cart
 */
export async function addMissingIngredientsToListi(db, items, listiUrl = process.env.LISTI_API_URL) {
  const upsertStmt = db.prepare(`
    INSERT INTO pantry_groceries (item_name, quantity, status, updated_at)
    VALUES (?, ?, 'ברשימת קניות', CURRENT_TIMESTAMP)
    ON CONFLICT(item_name) DO UPDATE SET
      status = 'ברשימת קניות',
      updated_at = CURRENT_TIMESTAMP
  `);

  const addedItems = [];
  for (const item of items) {
    const itemName = typeof item === 'object' ? (item.name || item.itemName) : String(item);
    const quantity = typeof item === 'object' ? `${item.amount || ''} ${item.unit || ''}`.trim() || '1' : '1';
    if (!itemName) continue;

    upsertStmt.run(itemName, quantity);
    addedItems.push({ item_name: itemName, quantity, status: 'ברשימת קניות' });
  }

  // Push to Fly.io cloud directly
  let cloudResult = null;
  try {
    cloudResult = await pushItemsToListi(addedItems);
  } catch (err) {
    console.error('Listi cloud push error:', err.message);
  }

  return {
    status: 'success',
    synced_locally: true,
    cloud_result: cloudResult,
    added_items: addedItems
  };
}
