import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from './db.js';
import { seedData } from './seed.js';
import { syncFromListi, pushToHealingCabin, addMissingIngredientsToListi } from './integrations.js';
import { scrapeRecipeFromUrl } from './scraper.js';
import { calculateRecipeMatches } from './matching.js';
import { syncListiCloudToDb } from './listiClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

export function createServer(customDb) {
  const db = customDb || getDatabase();
  seedData(db);

  const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Helper to read JSON request body
    const readJsonBody = () => new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
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
      // 1. Static UI Dashboard
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const filePath = path.join(__dirname, 'public', 'index.html');
        const content = fs.readFileSync(filePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
        return;
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

        sendJson(200, recipes);
        return;
      }

      // 3.1 POST /api/recipes/scrape - Scrape and extract recipe data from a URL
      if (req.method === 'POST' && pathname === '/api/recipes/scrape') {
        const body = await readJsonBody();
        const { url } = body;
        if (!url) {
          sendJson(400, { error: 'url parameter is required' });
          return;
        }

        try {
          const scraped = await scrapeRecipeFromUrl(url);
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
          protein_grams = 0, difficulty = 'בינוני', ingredients = [], tags = []
        } = body;

        if (!title) {
          sendJson(400, { error: 'Missing title field' });
          return;
        }

        const stmt = db.prepare(`
          INSERT INTO recipes (
            title, description, instructions, source_url, image_url,
            prep_time_minutes, calories, protein_grams, difficulty, ingredients, tags
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
          title, description, instructions, source_url, image_url,
          prep_time_minutes, calories, protein_grams, difficulty,
          JSON.stringify(ingredients), JSON.stringify(tags)
        );

        const newId = db.prepare('SELECT last_insert_rowid() as id').get().id;
        const created = db.prepare('SELECT * FROM recipes WHERE id = ?').get(newId);
        sendJson(201, created);
        return;
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
            r.title AS recipe_title, r.calories, r.protein_grams, r.description AS recipe_description
          FROM weekly_plan wp
          LEFT JOIN recipes r ON wp.recipe_id = r.id
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
          success: true,
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
