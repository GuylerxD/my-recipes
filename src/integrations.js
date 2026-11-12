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
  return recipes.map(r => ({
    title: r.title,
    description: r.description || '',
    calories: Number(r.calories) || 0,
    protein_grams: Number(r.protein_grams) || 0
  }));
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
