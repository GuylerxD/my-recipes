/**
 * Client for Listi Fly.io Cloud Service
 * Base URL: https://project-1-listi-checklist-app.fly.dev
 * Authentication: Authorization: Bearer 1201 and x-pin: 1201
 */

const LISTI_BASE_URL = process.env.LISTI_BASE_URL || 'https://project-1-listi-checklist-app.fly.dev';
const LISTI_PIN = process.env.LISTI_PIN || '1201';

export function getListiHeaders() {
  return {
    'Authorization': `Bearer ${LISTI_PIN}`,
    'x-pin': LISTI_PIN,
    'Content-Type': 'application/json',
    'User-Agent': 'MyRecipesApp/1.0'
  };
}

/**
 * Fetch pantry inventory from Listi (supports dedicated endpoint and /api/items fallback)
 */
export async function fetchListiPantry(listId = 1) {
  const headers = getListiHeaders();

  // 1. Try dedicated pantry endpoints
  for (const endpoint of [`/api/pantry?list_id=${listId}`, `/api/cabin/pantry?list_id=${listId}`]) {
    try {
      const res = await fetch(`${LISTI_BASE_URL}${endpoint}`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.pantry && Array.isArray(data.pantry)) {
          return data.pantry.map(i => ({
            name: i.text || i.name,
            quantity: String(i.stock_qty || i.quantity || '1'),
            status: 'במזווה',
            category: i.category || ''
          }));
        }
      }
    } catch {
      // Fallback to /api/items
    }
  }

  // 2. Fallback to /api/items?list_id=1
  const res = await fetch(`${LISTI_BASE_URL}/api/items?list_id=${listId}`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch from Listi: ${res.status} ${res.statusText}`);
  }

  const items = await res.json();
  // Items in pantry: stock_qty > 0 OR (done === 1 and stock_qty !== 0)
  return items
    .filter(i => (i.stock_qty > 0 || i.done === 1) && i.stock_qty !== 0)
    .map(i => ({
      name: i.text,
      quantity: String(i.stock_qty > 0 ? i.stock_qty : 1),
      status: 'במזווה',
      category: i.category || ''
    }));
}

/**
 * Fetch active shopping list from Listi
 */
export async function fetchListiShoppingList(listId = 1) {
  const headers = getListiHeaders();

  try {
    const res = await fetch(`${LISTI_BASE_URL}/api/shopping-list?list_id=${listId}`, { headers });
    if (res.ok) {
      const data = await res.json();
      if (data.items && Array.isArray(data.items)) {
        return data.items.map(i => ({
          name: i.text || i.name,
          quantity: String(i.qty || '1'),
          status: 'ברשימת קניות',
          category: i.category || ''
        }));
      }
    }
  } catch {
    // Fallback
  }

  const res = await fetch(`${LISTI_BASE_URL}/api/items?list_id=${listId}`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch shopping list from Listi: ${res.status}`);
  }

  const items = await res.json();
  return items
    .filter(i => i.done === 0)
    .map(i => ({
      name: i.text,
      quantity: String(i.qty || 1),
      status: 'ברשימת קניות',
      category: i.category || ''
    }));
}

/**
 * Add items directly to Listi shopping list
 */
export async function pushItemsToListi(items, listId = 1) {
  const headers = getListiHeaders();
  const itemNames = items.map(item => {
    if (typeof item === 'object') return item.name || item.itemName || item.text;
    return String(item);
  }).filter(Boolean);

  if (itemNames.length === 0) return { ok: true, added: [] };

  // 1. Try dedicated cabin shopping endpoint
  try {
    const res = await fetch(`${LISTI_BASE_URL}/api/cabin/shopping`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ items: itemNames, list_id: listId, qty: 1 })
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Fallback
  }

  // 2. Fallback: post each item to /api/items
  const results = [];
  for (const name of itemNames) {
    try {
      const res = await fetch(`${LISTI_BASE_URL}/api/items`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: name,
          list_id: listId,
          qty: 1,
          done: false
        })
      });
      if (res.ok) {
        results.push(name);
      }
    } catch (err) {
      console.error(`Error adding item "${name}" to Listi:`, err.message);
    }
  }

  return {
    ok: true,
    added: results,
    count: results.length
  };
}

/**
 * Full sync from Listi Cloud into local DB
 */
export async function syncListiCloudToDb(db, listId = 1) {
  const [pantryItems, shoppingItems] = await Promise.all([
    fetchListiPantry(listId),
    fetchListiShoppingList(listId)
  ]);

  const upsertStmt = db.prepare(`
    INSERT INTO pantry_groceries (item_name, quantity, status, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(item_name) DO UPDATE SET
      quantity = excluded.quantity,
      status = excluded.status,
      updated_at = CURRENT_TIMESTAMP
  `);

  let count = 0;
  for (const item of [...pantryItems, ...shoppingItems]) {
    upsertStmt.run(item.name, item.quantity, item.status);
    count++;
  }

  return {
    synced_total: count,
    pantry_count: pantryItems.length,
    shopping_count: shoppingItems.length
  };
}
