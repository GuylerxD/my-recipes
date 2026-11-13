import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from './db.js';
import { seedData } from './seed.js';
import { syncFromListi, pushToHealingCabin, addMissingIngredientsToListi } from './integrations.js';
import { importRecipe } from './recipeScraperService.js';
import { calculateRecipeMatches } from './matching.js';
import { syncListiCloudToDb, addItemToListiPantry } from './listiClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
if (fs.existsSync('.env')) {
  process.loadEnvFile?.();
}
const PORT = process.env.PORT || 3000;

export function createServer(customDb) {
  const db = customDb || getDatabase();
  seedData(db);

  const server = http.createServer(async (req, res) => {
    // The UI is served from this same server, so no CORS headers are sent. Browsers therefore
    // block other websites from reading responses; additionally reject state-changing requests
    // that a browser tags as coming from another site (simple form/text POSTs skip CORS preflight).
    // Requests without an Origin header (curl, server-to-server webhooks) are unaffected.
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin) {
      let originHost = null;
      try { originHost = new URL(origin).host; } catch {}
      if (originHost !== req.headers.host) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Cross-origin request blocked' }));
        return;
      }
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Helper to read JSON request body (capped so a huge upload can't exhaust memory)
    const MAX_BODY_BYTES = 2 * 1024 * 1024;
    const readJsonBody = () => new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_BODY_BYTES) {
          reject(new Error('Request body too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });

    const sendJson = (statusCode, data) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    try {
      // 1. Static UI Dashboard, PWA assets & Add Recipe route
      if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        const publicDir = path.resolve(__dirname, 'public');
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.css': 'text/css; charset=utf-8'
        };

        let targetRel = pathname === '/' || pathname === '/index.html'
          ? 'index.html'
          : pathname.replace(/^\/+/, '');
        if (targetRel === 'add-recipe' || targetRel === 'add-recipe/') {
          targetRel = path.join('add-recipe', 'index.html');
        }

        const resolvedPath = path.resolve(publicDir, targetRel);
        if (resolvedPath.startsWith(publicDir + path.sep) && fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
          const ext = path.extname(resolvedPath).toLowerCase();
          const contentType = resolvedPath.endsWith('manifest.json')
            ? 'application/manifest+json; charset=utf-8'
            : (mimeTypes[ext] || 'application/octet-stream');
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(fs.readFileSync(resolvedPath));
          return;
        }
      }

      // 2. GET /api/tags - Predefined and custom tags
      if (req.method === 'GET' && pathname === '/api/tags') {
        const rows = db.prepare('SELECT name FROM tags ORDER BY id ASC').all();
        sendJson(200, rows.map(r => r.name));
        return;
      }

      // 3. GET /api/recipes - All recipes or filtered by search / tags
      if (req.method === 'GET' && pathname === '/api/recipes') {
        const tagParam = parsedUrl.searchParams.get('tag');
        const tagsParam = parsedUrl.searchParams.get('tags');
        const searchParam = (parsedUrl.searchParams.get('q') || parsedUrl.searchParams.get('search') || '').trim().toLowerCase();

        const requestedTags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : (tagParam ? [tagParam.trim()] : []);

        let recipes = db.prepare('SELECT * FROM recipes ORDER BY id DESC').all();

        if (requestedTags.length > 0) {
          recipes = recipes.filter(r => {
            const recipeTags = JSON.parse(r.tags || '[]');
            return requestedTags.every(t => recipeTags.includes(t));
          });
        }

        if (searchParam) {
          recipes = recipes.filter(r => {
            const titleMatch = (r.title || '').toLowerCase().includes(searchParam);
            const descMatch = (r.description || '').toLowerCase().includes(searchParam);
            const ingredientsMatch = (r.ingredients || '').toLowerCase().includes(searchParam);
            return titleMatch || descMatch || ingredientsMatch;
          });
        }

        const basePrepParam = parsedUrl.searchParams.get('is_base_prep');
        if (basePrepParam !== null) {
          const expectBase = basePrepParam === 'true' || basePrepParam === '1';
          recipes = recipes.filter(r => Boolean(r.is_base_prep) === expectBase);
        }

        sendJson(200, recipes);
        return;
      }

      // 3.1 POST /api/recipes/smart-import - Smart recipe importer (URL or free text with LLM)
      if (req.method === 'POST' && pathname === '/api/recipes/smart-import') {
        const body = await readJsonBody();
        const { input, text, url, apiKey, provider } = body;
        const targetInput = input || text || url;
        if (!targetInput) {
          sendJson(400, { error: 'input parameter is required (URL or free text)' });
          return;
        }

        try {
          const imported = await importRecipe(targetInput, { apiKey, provider });
          sendJson(200, imported);
        } catch (err) {
          sendJson(422, { error: 'Failed to import recipe', details: err.message });
        }
        return;
      }

      // 3.2 GET or POST /api/recipes/scrape - Scrape and extract recipe data from a URL
      if ((req.method === 'POST' || req.method === 'GET') && pathname === '/api/recipes/scrape') {
        let url = parsedUrl.searchParams.get('url') || '';
        if (req.method === 'POST') {
          try {
            const body = await readJsonBody();
            url = body.url || url;
          } catch {}
        }
        if (!url) {
          sendJson(400, { error: 'url parameter is required' });
          return;
        }

        try {
          const scraped = await importRecipe(url);
          sendJson(200, scraped);
        } catch (err) {
          sendJson(422, { error: 'Failed to extract recipe from URL', details: err.message });
        }
        return;
      }

      // 4. POST /api/recipes - Create recipe
      if (req.method === 'POST' && pathname === '/api/recipes') {
        const body = await readJsonBody();
        const {
          title, description = '', instructions = '', source_url = '',
          image_url = '', prep_time_minutes = 0, calories = 0,
          protein_grams = 0, difficulty = 'בינוני', ingredients = [], tags = [],
          is_base_prep = false
        } = body;

        if (!title) {
          sendJson(400, { error: 'Missing title field' });
          return;
        }

        const stmt = db.prepare(`
          INSERT INTO recipes (
            title, description, instructions, source_url, image_url,
            prep_time_minutes, calories, protein_grams, difficulty, ingredients, tags, is_base_prep
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
          title, description, instructions, source_url, image_url,
          prep_time_minutes, calories, protein_grams, difficulty,
          JSON.stringify(ingredients), JSON.stringify(tags),
          is_base_prep ? 1 : 0
        );

        const newId = db.prepare('SELECT last_insert_rowid() as id').get().id;
        const created = db.prepare('SELECT * FROM recipes WHERE id = ?').get(newId);
        sendJson(201, created);
        return;
      }

      // 4.1 POST /api/recipes/reset-defaults - Restore built-in seed recipes
      if (req.method === 'POST' && pathname === '/api/recipes/reset-defaults') {
        seedData(db, true);
        const all = db.prepare('SELECT * FROM recipes ORDER BY id DESC').all();
        sendJson(200, all);
        return;
      }

      // 4.2 PUT / DELETE /api/recipes/:id - Update or delete recipe
      const recipeIdMatch = pathname.match(/^\/api\/recipes\/(\d+)$/);
      if (recipeIdMatch) {
        const recipeId = parseInt(recipeIdMatch[1], 10);

        if (req.method === 'PUT') {
          const existing = db.prepare('SELECT * FROM recipes WHERE id = ?').get(recipeId);
          if (!existing) {
            sendJson(404, { error: 'Recipe not found' });
            return;
          }

          const body = await readJsonBody();
          const title = String(body.title ?? existing.title ?? '').trim();
          if (!title) {
            sendJson(400, { error: 'Missing title field' });
            return;
          }

          const description = body.description !== undefined ? body.description : existing.description;
          const instructions = body.instructions !== undefined ? body.instructions : existing.instructions;
          const source_url = body.source_url !== undefined ? body.source_url : existing.source_url;
          const image_url = body.image_url !== undefined ? body.image_url : existing.image_url;
          const prep_time_minutes = body.prep_time_minutes !== undefined ? body.prep_time_minutes : existing.prep_time_minutes;
          const calories = body.calories !== undefined ? body.calories : existing.calories;
          const protein_grams = body.protein_grams !== undefined ? body.protein_grams : existing.protein_grams;
          const difficulty = body.difficulty !== undefined ? body.difficulty : existing.difficulty;
          const ingredients = body.ingredients !== undefined
            ? (typeof body.ingredients === 'string' ? body.ingredients : JSON.stringify(body.ingredients))
            : existing.ingredients;
          const tags = body.tags !== undefined
            ? (typeof body.tags === 'string' ? body.tags : JSON.stringify(body.tags))
            : existing.tags;
          const is_base_prep = body.is_base_prep !== undefined
            ? (body.is_base_prep ? 1 : 0)
            : existing.is_base_prep;

          db.prepare(`
            UPDATE recipes SET
              title = ?, description = ?, instructions = ?, source_url = ?, image_url = ?,
              prep_time_minutes = ?, calories = ?, protein_grams = ?, difficulty = ?,
              ingredients = ?, tags = ?, is_base_prep = ?
            WHERE id = ?
          `).run(
            title, description, instructions, source_url, image_url,
            prep_time_minutes, calories, protein_grams, difficulty,
            ingredients, tags, is_base_prep, recipeId
          );

          const updated = db.prepare('SELECT * FROM recipes WHERE id = ?').get(recipeId);
          sendJson(200, updated);
          return;
        }

        if (req.method === 'DELETE') {
          const result = db.prepare('DELETE FROM recipes WHERE id = ?').run(recipeId);
          if (result.changes === 0) {
            sendJson(404, { error: 'Recipe not found' });
            return;
          }
          sendJson(200, { success: true, deleted_id: recipeId });
          return;
        }
      }

      // 5. GET /api/pantry - List pantry and grocery items
      if (req.method === 'GET' && pathname === '/api/pantry') {
        const items = db.prepare('SELECT * FROM pantry_groceries ORDER BY updated_at DESC').all();
        sendJson(200, items);
        return;
      }

      // 5.1 GET /api/what-can-i-cook - Matching algorithm between recipes and pantry
      if (req.method === 'GET' && pathname === '/api/what-can-i-cook') {
        const tagsParam = parsedUrl.searchParams.get('tags') || parsedUrl.searchParams.get('tag');
        const minMatch = parseInt(parsedUrl.searchParams.get('min_match') || '0', 10);
        const maxMissing = parsedUrl.searchParams.has('max_missing') ? parseInt(parsedUrl.searchParams.get('max_missing'), 10) : null;

        const requestedTags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : [];

        let recipes = db.prepare('SELECT * FROM recipes').all();
        const pantry = db.prepare('SELECT * FROM pantry_groceries').all();

        // Tag filtering (AND logic)
        if (requestedTags.length > 0) {
          recipes = recipes.filter(r => {
            const recipeTags = JSON.parse(r.tags || '[]');
            return requestedTags.every(t => recipeTags.some(rt => rt === t || rt.startsWith(t)));
          });
        }

        let scored = calculateRecipeMatches(recipes, pantry);

        if (minMatch > 0) {
          scored = scored.filter(r => r.match_percentage >= minMatch);
        }

        if (maxMissing !== null && !isNaN(maxMissing)) {
          scored = scored.filter(r => r.missing_count <= maxMissing);
        }

        sendJson(200, scored);
        return;
      }

      // 5.2 POST /api/integrations/listi/add-missing - Quick-add missing ingredients to Listi
      if (req.method === 'POST' && pathname === '/api/integrations/listi/add-missing') {
        const body = await readJsonBody();
        const { items } = body;
        if (!items || !Array.isArray(items) || items.length === 0) {
          sendJson(400, { error: 'items array is required' });
          return;
        }

        const result = await addMissingIngredientsToListi(db, items);
        sendJson(200, result);
        return;
      }

      // 5.3 POST /api/integrations/listi/add-pantry - Add prepared base prep item to pantry
      if (req.method === 'POST' && pathname === '/api/integrations/listi/add-pantry') {
        const body = await readJsonBody();
        const itemName = body.item || body.name || body.title;
        const quantity = body.quantity || '1';
        if (!itemName) {
          sendJson(400, { error: 'item name is required' });
          return;
        }

        db.prepare(`
          INSERT INTO pantry_groceries (item_name, quantity, status, updated_at)
          VALUES (?, ?, 'במזווה', CURRENT_TIMESTAMP)
          ON CONFLICT(item_name) DO UPDATE SET
            quantity = excluded.quantity,
            status = 'במזווה',
            updated_at = CURRENT_TIMESTAMP
        `).run(itemName, String(quantity));

        try {
          await addItemToListiPantry(itemName, quantity);
        } catch (e) {
          console.warn('Listi cloud sync warning:', e.message);
        }

        sendJson(200, { success: true, item: itemName, status: 'במזווה' });
        return;
      }

      // 6. POST /api/integrations/listi - Webhook to receive inventory sync from Listi
      if (req.method === 'POST' && pathname === '/api/integrations/listi') {
        const body = await readJsonBody();
        const result = syncFromListi(db, body);
        sendJson(200, {
          success: true,
          message: 'Listi inventory synchronized successfully',
          ...result
        });
        return;
      }

      // 6.1 POST /api/integrations/listi/sync-now - Trigger pull from Listi Fly.io cloud directly
      if (req.method === 'POST' && pathname === '/api/integrations/listi/sync-now') {
        try {
          const listId = parseInt(parsedUrl.searchParams.get('list_id') || '1', 10);
          const result = await syncListiCloudToDb(db, listId);
          sendJson(200, {
            success: true,
            message: 'Listi cloud inventory synchronized successfully',
            ...result
          });
        } catch (err) {
          sendJson(500, { error: 'Failed to sync from Listi cloud', details: err.message });
        }
        return;
      }

      // 7. GET /api/weekly-plan - Retrieve current plan with joined recipe details
      if (req.method === 'GET' && pathname === '/api/weekly-plan') {
        const rows = db.prepare(`
          SELECT 
            wp.id, wp.day_of_week, wp.meal_type, wp.recipe_id, wp.notes, wp.updated_at,
            r.title AS title, r.title AS recipe_title, r.calories, r.protein_grams,
            r.description AS description, r.description AS recipe_description,
            r.image_url, r.is_base_prep
          FROM weekly_plan wp
          INNER JOIN recipes r ON wp.recipe_id = r.id
          ORDER BY wp.id ASC
        `).all();
        sendJson(200, rows);
        return;
      }

      // 8. POST /api/weekly-plan - Schedule recipe to day & meal slot
      if (req.method === 'POST' && pathname === '/api/weekly-plan') {
        const body = await readJsonBody();
        const { day_of_week, meal_type, recipe_id, notes = '' } = body;

        if (!day_of_week || !meal_type) {
          sendJson(400, { error: 'day_of_week and meal_type are required' });
          return;
        }

        if (!recipe_id) {
          // Clear slot
          db.prepare('DELETE FROM weekly_plan WHERE day_of_week = ? AND meal_type = ?').run(day_of_week, meal_type);
          sendJson(200, { success: true, message: 'Slot cleared' });
          return;
        }

        const recipeExists = db.prepare('SELECT id FROM recipes WHERE id = ?').get(recipe_id);
        if (!recipeExists) {
          sendJson(404, { error: 'Recipe not found for weekly plan slot' });
          return;
        }

        const upsertPlan = db.prepare(`
          INSERT INTO weekly_plan (day_of_week, meal_type, recipe_id, notes, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(day_of_week, meal_type) DO UPDATE SET
            recipe_id = excluded.recipe_id,
            notes = excluded.notes,
            updated_at = CURRENT_TIMESTAMP
        `);
        upsertPlan.run(day_of_week, meal_type, recipe_id, notes);

        sendJson(200, { success: true, message: 'Weekly plan slot updated' });
        return;
      }

      // 8.1 DELETE /api/weekly-plan - Remove slot
      if (req.method === 'DELETE' && pathname === '/api/weekly-plan') {
        const body = await readJsonBody();
        const { day_of_week, meal_type } = body;
        db.prepare('DELETE FROM weekly_plan WHERE day_of_week = ? AND meal_type = ?').run(day_of_week, meal_type);
        sendJson(200, { success: true, message: 'Slot removed' });
        return;
      }

      // 9. POST /api/weekly-plan/approve-and-push - Approves plan & pushes to The Healing Cabin
      if (req.method === 'POST' && pathname === '/api/weekly-plan/approve-and-push') {
        const body = await readJsonBody();
        let selectedRecipes = [];

        if (Array.isArray(body.recipes) && body.recipes.length > 0) {
          selectedRecipes = body.recipes;
        } else {
          // Query distinct recipes in the approved weekly plan with day and meal metadata
          selectedRecipes = db.prepare(`
            SELECT wp.day_of_week, wp.meal_type, r.id, r.title, r.description, r.calories, r.protein_grams
            FROM weekly_plan wp
            INNER JOIN recipes r ON wp.recipe_id = r.id
            ORDER BY wp.id ASC
          `).all();
        }

        const pushResult = await pushToHealingCabin(selectedRecipes);
        sendJson(200, {
          success: pushResult.status === 'success',
          action: 'WEEKLY_PLAN_APPROVED',
          recipes_count: selectedRecipes.length,
          push_result: pushResult
        });
        return;
      }

      // Not found
      sendJson(404, { error: 'Route not found' });
    } catch (err) {
      console.error('Server error:', err);
      sendJson(500, { error: 'Internal Server Error', details: err.message });
    }
  });

  return { server, db };
}

// Start if executed directly
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const { server } = createServer();
  server.listen(PORT, () => {
    console.log(`Smart Nutrition & Recipe Planner server listening on http://localhost:${PORT}`);
  });
}
