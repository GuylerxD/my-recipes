#!/usr/bin/env node
/**
 * Daily pantry snapshot: pulls the pantry and shopping list from Listi and writes
 * src/public/pantry.json, which the GitHub Pages app reads when it can't reach Listi live.
 *
 * Runs in the deploy workflow (every push + daily at 08:00 Israel time).
 * Never fails the build: if Listi is unreachable, it keeps the last deployed snapshot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LISTI_BASE = process.env.LISTI_BASE_URL || 'https://project-1-listi-checklist-app.fly.dev';
const LISTI_PIN = process.env.LISTI_PIN || '1201';
const LIST_ID = process.env.LISTI_LIST_ID || '1';
const DEPLOYED_SNAPSHOT = process.env.DEPLOYED_SNAPSHOT_URL || 'https://guylerxd.github.io/my-recipes/pantry.json';
const NON_FOOD_CATEGORY = /ניקיון|פארם/;

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.PANTRY_OUT || path.join(here, '..', 'src', 'public', 'pantry.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, { tries = 3, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'x-pin': LISTI_PIN, Authorization: `Bearer ${LISTI_PIN}`, 'User-Agent': 'MyRecipesDailySync/1.0' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.warn(`  attempt ${i}/${tries} failed for ${url.split('?')[0]}: ${err.cause?.code || err.message}`);
      if (i < tries) await sleep(5000 * i); // Fly machines can take a while to wake up
    }
  }
  throw lastErr;
}

const clean = list => [...new Set(list.map(s => String(s || '').trim()).filter(Boolean))];
const isFood = item => !NON_FOOD_CATEGORY.test(item.category || '');

async function fetchFromListi() {
  const q = `list_id=${LIST_ID}&pin=${LISTI_PIN}`;
  const [pantryData, shopData] = await Promise.all([
    getJson(`${LISTI_BASE}/api/pantry?${q}`),
    getJson(`${LISTI_BASE}/api/shopping-list?${q}`).catch(err => {
      console.warn(`  shopping list unavailable: ${err.message}`);
      return null;
    })
  ]);

  const inStock = (pantryData.pantry || []).filter(p => Number(p.stock_qty) > 0 && isFood(p));
  const shoppingItems = ((shopData && shopData.items) || []).filter(isFood);

  return {
    synced_at: new Date().toISOString(),
    source: 'listi-daily',
    stock: clean(inStock.map(p => p.text || p.name)),
    shopping: clean(shoppingItems.map(i => i.text || i.name)),
    pantry: [
      ...inStock.map(p => ({
        item_name: String(p.text || p.name || '').trim(),
        quantity: String(p.stock_qty),
        category: p.category || '',
        status: 'in_pantry'
      })),
      ...shoppingItems.map(i => ({
        item_name: String(i.text || i.name || '').trim(),
        quantity: String(i.qty || 1),
        category: i.category || '',
        status: 'in_grocery_list'
      }))
    ].filter(i => i.item_name)
  };
}

async function keepLastSnapshot() {
  if (fs.existsSync(OUT)) {
    console.warn('  keeping existing local pantry.json');
    return;
  }
  try {
    const prev = await getJson(DEPLOYED_SNAPSHOT, { tries: 2, timeoutMs: 15000 });
    if (prev && Array.isArray(prev.stock)) {
      fs.writeFileSync(OUT, JSON.stringify(prev, null, 2));
      console.warn(`  kept last deployed snapshot from ${prev.synced_at}`);
      return;
    }
  } catch (err) {
    console.warn(`  no deployed snapshot available: ${err.message}`);
  }
  console.warn('  no snapshot written; the app will fall back to its own cache');
}

try {
  const snapshot = await fetchFromListi();
  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
  console.log(`Listi sync OK: ${snapshot.stock.length} in stock, ${snapshot.shopping.length} on shopping list -> ${OUT}`);
} catch (err) {
  console.warn(`::warning::Listi sync failed (${err.cause?.code || err.message}); deploy continues.`);
  await keepLastSnapshot();
}
