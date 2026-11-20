/**
 * Integration services for Listi.
 *
 * The Healing Cabin is no longer pushed to from the server: the frontend's "אכלתי ✓"
 * button writes eaten meals to localStorage (healing_cabin_eaten_meals), which the
 * Cabin reads on the same GitHub Pages origin. See index.html (EATEN LOG).
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
