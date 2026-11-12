import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'nutrition.db');

export const PREDEFINED_TAGS = [
  'עתיר חלבון',
  'דל סוכר',
  'מתאים לנינג\'ה קרימי',
  'מתאים לנינג\'ה סלאשי',
  'נינג\'ה אייר פרייר',
  'צמחוני',
  'מנות דגים (ללא בקר ועוף)',
  'ללא כוסברה',
  'ללא סלטים'
];

export function getDatabase(dbPath = DB_PATH) {
  const db = new DatabaseSync(dbPath);

  // Initialize Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      instructions TEXT,
      source_url TEXT,
      image_url TEXT,
      prep_time_minutes INTEGER DEFAULT 0,
      calories INTEGER DEFAULT 0,
      protein_grams REAL DEFAULT 0,
      difficulty TEXT DEFAULT 'בינוני',
      ingredients TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      is_base_prep INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pantry_groceries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_name TEXT UNIQUE NOT NULL,
      quantity TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('במזווה', 'חסר', 'ברשימת קניות')),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS weekly_plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_of_week TEXT NOT NULL,
      meal_type TEXT NOT NULL,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      notes TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(day_of_week, meal_type)
    );
  `);

  // Safe migration for is_base_prep column
  try {
    db.prepare('ALTER TABLE recipes ADD COLUMN is_base_prep INTEGER DEFAULT 0').run();
  } catch {}

  // Seed default tags
  const insertTagStmt = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  for (const tag of PREDEFINED_TAGS) {
    insertTagStmt.run(tag);
  }

  return db;
}
