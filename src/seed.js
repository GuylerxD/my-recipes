import { getDatabase } from './db.js';

export function seedData(db) {
  const insertRecipeStmt = db.prepare(`
    INSERT INTO recipes (
      title, description, instructions, source_url, image_url,
      prep_time_minutes, calories, protein_grams, difficulty, ingredients, tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const count = db.prepare('SELECT COUNT(*) as count FROM recipes').get().count;
  if (count === 0) {
    const sampleRecipes = [
      {
        title: 'גלידת חלבון וניל לנינג\'ה קרימי',
        description: 'גלידת וניל קרמית במיוחד, עתירת חלבון וללא תוספת סוכר, מושלמת לנינג\'ה קרימי.',
        instructions: '1. מערבבים חלב שקדים, סקופ אבקת חלבון ופודינג וניל.\n2. מקפיאים ל-24 שעות במכל הייעודי.\n3. מעבדים בתוכנית Lite Ice Cream בנינג\'ה קרימי.',
        source_url: 'https://recipes.local/creami-vanilla',
        image_url: 'https://images.unsplash.com/photo-1570197788417-0e82375c9371?w=600',
        prep_time_minutes: 5,
        calories: 190,
        protein_grams: 32,
        difficulty: 'קל',
        ingredients: JSON.stringify([
          { name: 'חלב שקדים ללא סוכר', amount: '350', unit: 'מ"ל' },
          { name: 'אבקת חלבון וניל', amount: '1', unit: 'סקופ (33 גרם)' },
          { name: 'אינסטנט פודינג ללא סוכר', amount: '7', unit: 'גרם' }
        ]),
        tags: JSON.stringify(['עתיר חלבון', 'דל סוכר', 'מתאים לנינג\'ה קרימי', 'צמחוני', 'ללא כוסברה', 'ללא סלטים'])
      },
      {
        title: 'פילה סלמון צלוי בעשבי תיבול וחרדל',
        description: 'מנת דג עסיסית ומהירה בתנור עם ציפוי חרדל דיז\'ון ושום.',
        instructions: '1. מחממים תנור ל-200 מעלות.\n2. מורחים על פילה הסלמון חרדל דיז\'ון, שמן זית, שום כתוש ומלח גס.\n3. אופים במשך 14-16 דקות.',
        source_url: 'https://recipes.local/baked-salmon',
        image_url: 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=600',
        prep_time_minutes: 20,
        calories: 380,
        protein_grams: 41,
        difficulty: 'קל',
        ingredients: JSON.stringify([
          { name: 'פילה סלמון טרי', amount: '220', unit: 'גרם' },
          { name: 'חרדל דיז\'ון גרגרים', amount: '1', unit: 'כף' },
          { name: 'שמן זית', amount: '1', unit: 'כפית' },
          { name: 'שום כתוש', amount: '2', unit: 'שיניים' }
        ]),
        tags: JSON.stringify(['עתיר חלבון', 'דל סוכר', 'מנות דגים (ללא בקר ועוף)', 'ללא כוסברה', 'ללא סלטים'])
      },
      {
        title: 'משקה קפוא אבטיח וליים לנינג\'ה סלאשי',
        description: 'סלאשי פירות מרענן וטבעי, ללא תוספת סוכר.',
        instructions: '1. חותכים אבטיח לקוביות ומסננים.\n2. מוסיפים מיץ מחצי ליים ומים קרים.\n3. מוזגים למכל הנינג\'ה סלאשי ומפעילים במצב Slush.',
        source_url: 'https://recipes.local/watermelon-slush',
        image_url: 'https://images.unsplash.com/photo-1527661591475-527312dd65f5?w=600',
        prep_time_minutes: 10,
        calories: 85,
        protein_grams: 2,
        difficulty: 'קל',
        ingredients: JSON.stringify([
          { name: 'אבטיח טרי', amount: '400', unit: 'גרם' },
          { name: 'מיץ ליים טרי', amount: '1', unit: 'כף' },
          { name: 'מים קרים', amount: '100', unit: 'מ"ל' }
        ]),
        tags: JSON.stringify(['דל סוכר', 'מתאים לנינג\'ה סלאשי', 'צמחוני', 'ללא כוסברה', 'ללא סלטים'])
      }
    ];

    for (const r of sampleRecipes) {
      insertRecipeStmt.run(
        r.title, r.description, r.instructions, r.source_url, r.image_url,
        r.prep_time_minutes, r.calories, r.protein_grams, r.difficulty, r.ingredients, r.tags
      );
    }
  }

  // Pre-seed pantry / groceries
  const pantryCount = db.prepare('SELECT COUNT(*) as count FROM pantry_groceries').get().count;
  if (pantryCount === 0) {
    const insertPantryStmt = db.prepare('INSERT INTO pantry_groceries (item_name, quantity, status) VALUES (?, ?, ?)');
    insertPantryStmt.run('פילה סלמון', '2 יחידות', 'במזווה');
    insertPantryStmt.run('אבקת חלבון וניל', '1 קופסה', 'במזווה');
    insertPantryStmt.run('חלב שקדים ללא סוכר', '0', 'חסר');
    insertPantryStmt.run('חרדל דיז\'ון', '1 צנצנת', 'ברשימת קניות');
  }

  // Pre-seed weekly plan
  const planCount = db.prepare('SELECT COUNT(*) as count FROM weekly_plan').get().count;
  if (planCount === 0) {
    const firstRecipe = db.prepare('SELECT id FROM recipes LIMIT 1').get();
    if (firstRecipe) {
      const insertPlanStmt = db.prepare('INSERT INTO weekly_plan (day_of_week, meal_type, recipe_id, notes) VALUES (?, ?, ?, ?)');
      insertPlanStmt.run('ראשון', 'צהריים', firstRecipe.id, 'הכנה מראש ביום שבת');
    }
  }
}

// Standalone execution
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const db = getDatabase();
  seedData(db);
  console.log('Database successfully seeded.');
}
