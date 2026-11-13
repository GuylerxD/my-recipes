import { getDatabase } from './db.js';

export const USER_CUSTOM_RECIPES = [
  {
    title: 'טוסט גבינה צהובה וקפה של בוקר',
    description: 'טוסט גבינה צהובה וגבינת שמנת בלחמנייה מחיטה מלאה לצד קפה לונגו עם חלב מוקצף וקינוח מדוד למיתון קפיצת הסוכר.',
    instructions: '1. מורחים את גבינת השמנת או רסק העגבניות על הלחמנייה, מניחים את הגבינה הצהובה וקולים בטוסטר.\n2. מכינים לונגו מקפסולה 11 עם מעט חלב מוקצף.\n3. את המתוק אוכלים בסוף הארוחה כדי למתן את קפיצת הסוכר.',
    source_url: 'https://recipes.local/breakfast-toast',
    image_url: 'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=600',
    prep_time_minutes: 5,
    calories: 400,
    protein_grams: 19,
    difficulty: 'קל',
    ingredients: JSON.stringify([
      { name: 'לחמנייה מחיטה מלאה', amount: '1', unit: 'יחידה' },
      { name: 'גבינה צהובה', amount: '1', unit: 'פרוסה' },
      { name: 'גבינת שמנת 5% או רסק עגבניות טבעי', amount: '1', unit: 'כף' },
      { name: 'קפסולת קפה עלית מספר 11', amount: '1', unit: 'יחידה' },
      { name: 'חלב מוקצף', amount: 'מעט', unit: '' },
      { name: 'עוגה ביתית דקה או עוגייה אחת', amount: '1', unit: 'יחידה' }
    ]),
    tags: JSON.stringify(['צמחוני', 'ללא כוסברה', 'ללא סלטים'])
  },
  {
    title: 'סנאק בוקר חלבוני',
    description: 'גביע יוגורט טבעי מועשר בחלבון עם אצבע מוצרלה או לחמניית קוטג\' קטנה לאיזון אופטימלי של סוכר ולתחושת שובע עד הצהריים.',
    instructions: 'אוכלים את היוגורט יחד עם אצבע המוצרלה או לחמניית הקוטג\' לאיזון אופטימלי של סוכר ולתחושת שובע עד צהריים.',
    source_url: 'https://recipes.local/snack-am',
    image_url: 'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=600',
    prep_time_minutes: 2,
    calories: 200,
    protein_grams: 27,
    difficulty: 'קל',
    ingredients: JSON.stringify([
      { name: 'יוגורט טבעי מועשר בחלבון', amount: '1', unit: 'גביע' },
      { name: 'אצבע מוצרלה או לחמניית קוטג\' קטנה', amount: '1', unit: 'יחידה' }
    ]),
    tags: JSON.stringify(['עתיר חלבון', 'דל סוכר', 'צמחוני', 'ללא כוסברה', 'ללא סלטים'])
  },
  {
    title: 'קוביות טופו קריספי ומקלות בטטה',
    description: 'קוביות טופו פריכות ברוטב סויה ומקלות בטטה זהובים בנינג\'ה אייר פרייר לצד סלט ירקות רענן בשמן זית.',
    instructions: '1. חותכים את הטופו לקוביות, מערבבים עם סויה וקורנפלור.\n2. חותכים את הבטטה למקלות.\n3. מכניסים את הטופו והבטטה לנינג\'ה אייר פרייר ב-200 מעלות ל-15 דקות עד פריכות.\n4. מגישים עם סלט קטן מתובל בשמן זית.',
    source_url: 'https://recipes.local/airfryer-tofu',
    image_url: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600',
    prep_time_minutes: 20,
    calories: 410,
    protein_grams: 27,
    difficulty: 'קל',
    ingredients: JSON.stringify([
      { name: 'טופו קשה (מיובש מנוזלים)', amount: '150', unit: 'גרם' },
      { name: 'רוטב סויה', amount: '1', unit: 'כף' },
      { name: 'קורנפלור', amount: '1', unit: 'כפית' },
      { name: 'בטטה (או תפוח אדמה)', amount: '150', unit: 'גרם' },
      { name: 'מלפפון ועגבנייה לסלט', amount: '1', unit: 'מנה' },
      { name: 'שמן זית', amount: '1', unit: 'כפית' }
    ]),
    tags: JSON.stringify(['עתיר חלבון', 'דל סוכר', 'נינג\'ה אייר פרייר', 'צמחוני', 'ללא כוסברה'])
  },
  {
    title: 'סלמון באייר פרייר וקינואה',
    description: 'פילה סלמון עסיסי צלוי בנינג\'ה אייר פרייר ב-190 מעלות עם זוקיני וגמבה, מוגש לצד קינואה או אורז בסיר אורז.',
    instructions: '1. מתבלים את הסלמון והירקות (מלח, פלפל, שום, מעט שמן זית).\n2. מניחים בנינג\'ה אייר פרייר ב-190 מעלות לכ-10 דקות עד שהסלמון מוכן והירקות קלויים.\n3. מכינים את הקינואה/אורז בסיר אורז ומגישים הכל יחד.',
    source_url: 'https://recipes.local/airfryer-salmon-quinoa',
    image_url: 'https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=600',
    prep_time_minutes: 15,
    calories: 470,
    protein_grams: 36,
    difficulty: 'בינוני',
    ingredients: JSON.stringify([
      { name: 'פילה סלמון טרי', amount: '150', unit: 'גרם' },
      { name: 'קינואה או אורז (אחרי בישול)', amount: '1/2', unit: 'כוס' },
      { name: 'זוקיני וגמבה חתוכים', amount: '1', unit: 'מנה' },
      { name: 'תבלינים לסלמון (מלח, פלפל, שום, מעט שמן זית)', amount: '1', unit: 'מנה' }
    ]),
    tags: JSON.stringify(['עתיר חלבון', 'דל סוכר', 'נינג\'ה אייר פרייר', 'מנות דגים (ללא בקר ועוף)', 'ללא כוסברה', 'ללא סלטים'])
  },
  {
    title: 'סלט טונה קראנצ\'י',
    description: 'סלט טונה מהיר עם מיונז לייט, מיקס חסה ועגבניות שרי, מוגש עם פריכיות כוסמת או תפוח אדמה קטן אפוי באייר פרייר.',
    instructions: '1. מערבבים את הטונה המסוננת עם כף מיונז לייט.\n2. מסדרים חסה ועגבניות שרי בקערה ומניחים מעל את סלט הטונה.\n3. אוכלים עם 2 פריכיות כוסמת או תפוח אדמה קטן קלוי באייר פרייר.',
    source_url: 'https://recipes.local/tuna-crunch',
    image_url: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=600',
    prep_time_minutes: 5,
    calories: 270,
    protein_grams: 28,
    difficulty: 'קל',
    ingredients: JSON.stringify([
      { name: 'טונה במים (מסוננת)', amount: '100', unit: 'גרם' },
      { name: 'מיונז לייט', amount: '1', unit: 'כף' },
      { name: 'פריכיות כוסמת או תפו"א קטן באייר פרייר', amount: '2', unit: 'יחידות' },
      { name: 'מיקס חסה ועגבניות שרי', amount: '1', unit: 'קערה' }
    ]),
    tags: JSON.stringify(['עתיר חלבון', 'דל סוכר', 'מנות דגים (ללא בקר ועוף)', 'ללא כוסברה'])
  },
  {
    title: 'גלידת חלבון מפנקת',
    description: 'גלידת חלבון קטיפתית בנינג\'ה קרימי ממשקה חלבון או יוגורט עם תמצית וניל, מעובדת בתוכנית Lite Ice Cream.',
    instructions: '1. מוזגים את משקה החלבון או היוגורט ותמצית הווניל למיכל הקרימי ומקפיאים ל-24 שעות.\n2. מעבדים בתוכנית Lite Ice Cream בנינג\'ה קרימי.\n3. אם המרקם פירורי, מוסיפים שלוק חלב ומעבדים שוב ב-Re-spin.',
    source_url: 'https://recipes.local/protein-creami',
    image_url: 'https://images.unsplash.com/photo-1570197788417-0e82375c9371?w=600',
    prep_time_minutes: 5,
    calories: 150,
    protein_grams: 20,
    difficulty: 'קל',
    ingredients: JSON.stringify([
      { name: 'משקה חלבון מוכן (או יוגורט חלבון מעורבב עם מעט חלב סויה)', amount: '1', unit: 'מנה' },
      { name: 'תמצית וניל', amount: '1', unit: 'כפית' }
    ]),
    tags: JSON.stringify(['עתיר חלבון', 'דל סוכר', 'מתאים לנינג\'ה קרימי', 'צמחוני', 'ללא כוסברה', 'ללא סלטים'])
  },
  {
    title: 'ברד אנרגיה וחטיף מאוזן',
    description: 'ברד אנרגיה קפוא בנינג\'ה סלאשי לצד חטיף מלוח בטבילת יוגורט להאטת ספיגת פחמימות ושמירה על איזון ב-PCOS.',
    instructions: '1. מוזגים פחית משקה אנרגיה ללא סוכר למכל הנינג\'ה סלאשי ומפעילים במצב Slush.\n2. בזמן שהוא קופא, טובלים את החטיף המלוח ב-2 כפות יוגורט טבעי (מאט ספיגת פחמימות ומאזן סוכר).',
    source_url: 'https://recipes.local/energy-slushi',
    image_url: 'https://images.unsplash.com/photo-1527661591475-527312dd65f5?w=600',
    prep_time_minutes: 10,
    calories: 160,
    protein_grams: 3,
    difficulty: 'קל',
    ingredients: JSON.stringify([
      { name: 'פחית מונסטר או רדבול ללא סוכר', amount: '1', unit: 'פחית' },
      { name: 'חטיף: דובונים / צ\'יטוס / חטיף תאילנדי', amount: '25', unit: 'גרם' },
      { name: 'יוגורט טבעי (לטבילה)', amount: '2', unit: 'כפות' }
    ]),
    tags: JSON.stringify(['דל סוכר', 'מתאים לנינג\'ה סלאשי', 'צמחוני', 'ללא כוסברה', 'ללא סלטים'])
  },
  {
    title: 'חביתת ירק וטוסט מחמצת',
    description: 'חביתת ירק עשירה מבצל ירוק, עירית ועגבניות שרי לצד טוסט מחמצת מרוח בגבינה, כוס תה ו-2 קוביות שוקולד מריר.',
    instructions: '1. מקפיצים בצל לבן, בצל ירוק, עירית ועגבניות שרי במחבת עם תרסיס שמן.\n2. טורפים 2 ביצים ושופכים מעל עד שמוכן.\n3. קולים לחם מחמצת בטוסטר ומורחים גבינת קוטג\'/לבנה/סימפוניה 5%.\n4. מגישים הכל יחד ומסיימים עם תה חם ו-2 קוביות שוקולד מריר.',
    source_url: 'https://recipes.local/veggie-omelet',
    image_url: 'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=600',
    prep_time_minutes: 10,
    calories: 350,
    protein_grams: 23,
    difficulty: 'קל',
    ingredients: JSON.stringify([
      { name: 'לחם מחמצת', amount: '1', unit: 'פרוסה' },
      { name: 'קוטג\', לבנה 5% או סימפוניה 5%', amount: '2', unit: 'כפות' },
      { name: 'ביצים', amount: '2', unit: 'יחידות' },
      { name: 'עגבניות שרי, בצל לבן, בצל ירוק ועירית', amount: '1', unit: 'מנה' },
      { name: 'תרסיס שמן', amount: '1', unit: 'ריסוס' },
      { name: 'שוקולד מריר', amount: '2', unit: 'קוביות' },
      { name: 'תה', amount: '1', unit: 'כוס' }
    ]),
    tags: JSON.stringify(['עתיר חלבון', 'דל סוכר', 'צמחוני', 'ללא כוסברה', 'ללא סלטים'])
  }
];

export function seedData(db, force = false) {
  const recipeCount = db.prepare('SELECT COUNT(*) as count FROM recipes').get().count;
  if (recipeCount === 0 || force) {
    const insertRecipeStmt = db.prepare(`
      INSERT INTO recipes (
        title, description, instructions, source_url, image_url,
        prep_time_minutes, calories, protein_grams, difficulty, ingredients, tags, is_base_prep
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const existingTitles = new Set(
      db.prepare('SELECT title FROM recipes').all().map(r => r.title)
    );

    for (const r of USER_CUSTOM_RECIPES) {
      if (!existingTitles.has(r.title)) {
        insertRecipeStmt.run(
          r.title, r.description, r.instructions, r.source_url, r.image_url,
          r.prep_time_minutes, r.calories, r.protein_grams, r.difficulty, r.ingredients, r.tags,
          r.is_base_prep ? 1 : 0
        );
        existingTitles.add(r.title);
      }
    }
  }

  // Pre-seed pantry / groceries
  const pantryCount = db.prepare('SELECT COUNT(*) as count FROM pantry_groceries').get().count;
  if (pantryCount === 0) {
    const insertPantryStmt = db.prepare('INSERT INTO pantry_groceries (item_name, quantity, status) VALUES (?, ?, ?)');
    insertPantryStmt.run('פילה סלמון', '2 יחידות', 'במזווה');
    insertPantryStmt.run('יוגורט טבעי מועשר בחלבון', '2 גביעים', 'במזווה');
    insertPantryStmt.run('טופו קשה (מיובש מנוזלים)', '1 חבילה', 'במזווה');
    insertPantryStmt.run('לחם מחמצת', '1 כיכר', 'במזווה');
    insertPantryStmt.run('ביצים', '12 יחידות', 'במזווה');
  }

  // Pre-seed weekly plan
  const planCount = db.prepare('SELECT COUNT(*) as count FROM weekly_plan').get().count;
  if (planCount === 0) {
    const firstRecipe = db.prepare('SELECT id FROM recipes LIMIT 1').get();
    if (firstRecipe) {
      const insertPlanStmt = db.prepare('INSERT INTO weekly_plan (day_of_week, meal_type, recipe_id, notes) VALUES (?, ?, ?, ?)');
      insertPlanStmt.run('ראשון', 'בוקר', firstRecipe.id, 'ארוחת פתיחה שבועית');
    }
  }
}

// Standalone execution
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const db = getDatabase();
  seedData(db);
  console.log('Database successfully seeded with custom recipes.');
}
