import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from './db.js';
import { seedData } from './seed.js';
import { syncFromListi, pushToHealingCabin } from './integrations.js';

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

      // 3. GET /api/recipes - All recipes or filtered by tag
      if (req.method === 'GET' && pathname === '/api/recipes') {
        const tag = parsedUrl.searchParams.get('tag');
        let recipes = db.prepare('SELECT * FROM recipes ORDER BY id DESC').all();
        if (tag) {
          recipes = recipes.filter(r => {
            const tags = JSON.parse(r.tags || '[]');
            return tags.includes(tag);
          });
        }
        sendJson(200, recipes);
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

        if (!day_of_week || !meal_type || !recipe_id) {
          sendJson(400, { error: 'day_of_week, meal_type, and recipe_id are required' });
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

      // 9. POST /api/weekly-plan/approve-and-push - Approves plan & pushes to The Healing Cabin
      if (req.method === 'POST' && pathname === '/api/weekly-plan/approve-and-push') {
        // Query distinct recipes in the approved weekly plan
        const selectedRecipes = db.prepare(`
          SELECT DISTINCT r.id, r.title, r.description, r.calories, r.protein_grams
          FROM weekly_plan wp
          INNER JOIN recipes r ON wp.recipe_id = r.id
        `).all();

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
