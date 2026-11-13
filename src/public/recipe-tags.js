/**
 * Shared recipe-import helpers, used by both the browser (classic <script>) and the
 * Node server (imported for its side effect). Exposes globalThis.RecipeTags.
 *
 * - IMPORT_PROMPT: the one prompt every AI import path sends.
 * - inferTags(recipe, tags): fixes/completes tags from the recipe's actual words,
 *   matching whole Hebrew words (with prefixes ו/ה/ב/ל/מ/ש/כ) instead of substrings,
 *   so e.g. "דגנים" is not fish and "קציצות בקר" is not vegetarian.
 */
(function (root) {
  const TAG = {
    protein: 'עתיר חלבון',
    lowSugar: 'דל סוכר',
    creami: 'מתאים לנינג\'ה קרימי',
    slushi: 'מתאים לנינג\'ה סלאשי',
    airFryer: 'נינג\'ה אייר פרייר',
    vegetarian: 'צמחוני',
    fish: 'מנות דגים (ללא בקר ועוף)',
    noCilantro: 'ללא כוסברה',
    noSalads: 'ללא סלטים'
  };
  const PREDEFINED = Object.values(TAG);

  const IMPORT_PROMPT = `אתה עוזר קולינרי. קבל את הטקסט הבא וחלץ ממנו את המתכון. החזר אך ורק אובייקט JSON עם השדות:
title (String), description (String, משפט או שניים), ingredients (Array of strings, כל מצרך עם הכמות שלו), instructions (Array of strings), prep_time_minutes (Number), difficulty ("קל" / "בינוני" / "קשה"),
calories (Number - הערכה למנה אחת, או null אם אי אפשר להעריך), protein_grams (Number - הערכה למנה אחת, או null אם אי אפשר להעריך),
tags (Array of strings - רק מתוך הרשימה הבאה ורק אם מתאים: ${PREDEFINED.join(', ')}).
אל תמציא מצרכים או שלבים שלא מופיעים בטקסט.`;

  const HEB_PREFIXES = 'והבלמשכ';
  const FISH = ['דג', 'דגים', 'דגי', 'סלמון', 'טונה', 'אמנון', 'לברק', 'דניס', 'בקלה', 'מוסר', 'סרדין', 'סרדינים', 'מקרל', 'פורל', 'הליבוט', 'נסיכת', 'salmon', 'tuna', 'fish', 'cod', 'trout', 'sardines', 'mackerel'];
  const SEAFOOD = ['שרימפס', 'חסילונים', 'קלמרי', 'פירות ים', 'shrimp', 'prawns', 'squid', 'calamari'];
  const MEAT = ['בשר', 'עוף', 'עופות','בקר', 'הודו', 'כבש', 'טלה', 'חזיר', 'פרגית', 'פרגיות', 'שניצל', 'שניצלים', 'נקניק', 'נקניקיות', 'נקניקייה', 'קבב', 'המבורגר', 'אנטריקוט', 'סטייק', 'פסטרמה', 'סלמי', 'בייקון', 'שווארמה', 'אסאדו', 'כנפיים', 'שוקיים', 'כרעיים', 'אווז', 'ברווז', 'chicken', 'beef', 'turkey', 'pork', 'lamb', 'meat', 'bacon', 'steak', 'ham', 'sausage'];
  const SUGAR = ['סוכר', 'דבש', 'סילאן', 'מייפל', 'סירופ', 'ריבה', 'sugar', 'honey', 'syrup', 'maple', 'jam'];
  const CILANTRO = ['כוסברה', 'cilantro', 'coriander'];
  const SALAD = ['סלט', 'סלטים', 'salad'];
  const PROTEIN = ['חלבון', 'protein'];

  function normalizeText(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[֑-ׇ]/g, '') // niqqud
      .replace(/(ללא|בלי)\s+(תוספת\s+)?סוכר|sugar[- ]?free|no\s+sugar/g, ' ');
  }

  function tokenize(text) {
    return normalizeText(text).split(/[^a-zא-ת]+/).filter(Boolean);
  }

  function wordVariants(token) {
    const out = [token];
    let t = token;
    for (let i = 0; i < 2 && t.length > 2 && HEB_PREFIXES.includes(t[0]); i++) {
      t = t.slice(1);
      out.push(t);
    }
    return out;
  }

  function hasAnyWord(tokens, joined, words) {
    return words.some(w => {
      if (w.includes(' ')) return joined.includes(w);
      return tokens.some(tok => wordVariants(tok).includes(w));
    });
  }

  function ingredientText(ing) {
    if (ing && typeof ing === 'object') return ing.name || '';
    return String(ing || '');
  }

  function toList(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
      return value.split('\n');
    }
    return [];
  }

  function canonicalTag(tag) {
    const t = String(tag || '').trim();
    if (!t) return '';
    if (t.startsWith('מנות דגים')) return TAG.fish;
    if (t.includes('אייר פרייר') && t !== TAG.airFryer) return TAG.airFryer;
    if (t.includes('קרימי') && t !== TAG.creami) return TAG.creami;
    if (t.includes('סלאשי') && t !== TAG.slushi) return TAG.slushi;
    return t;
  }

  /**
   * @param {{title?:string, ingredients?:any, instructions?:any, protein_grams?:number}} recipe
   * @param {string[]} [initialTags] tags suggested by the AI / user
   * @returns {string[]} predefined tags first (in canonical order), then any custom tags
   */
  function inferTags(recipe, initialTags = []) {
    const ingredients = toList(recipe.ingredients).map(ingredientText).filter(Boolean);
    const instructions = toList(recipe.instructions).map(String);
    const fullText = [recipe.title || '', ...ingredients, ...instructions].join(' \n ');
    const joined = normalizeText(fullText);
    const tokens = tokenize(fullText);
    const has = words => hasAnyWord(tokens, joined, words);

    const tags = new Set(toList(initialTags).map(canonicalTag).filter(Boolean));
    const add = t => tags.add(t);
    const remove = t => tags.delete(t);
    // Absence-based tags ("no X", "vegetarian") are only safe when we can see the ingredients.
    const knowsIngredients = ingredients.length > 0;

    const hasMeat = has(MEAT);
    const hasFish = has(FISH);
    const hasSeafood = has(SEAFOOD);

    if (hasMeat || hasFish || hasSeafood) remove(TAG.vegetarian);
    else if (knowsIngredients) add(TAG.vegetarian);

    if (hasMeat) remove(TAG.fish);
    else if (hasFish) add(TAG.fish);

    if (has(SUGAR)) remove(TAG.lowSugar);
    else if (knowsIngredients) add(TAG.lowSugar);

    if (has(CILANTRO)) remove(TAG.noCilantro);
    else if (knowsIngredients) add(TAG.noCilantro);

    if (has(SALAD)) remove(TAG.noSalads);
    else if (knowsIngredients) add(TAG.noSalads);

    if (Number(recipe.protein_grams) >= 20 || has(PROTEIN)) add(TAG.protein);

    if (joined.includes('אייר פרייר') || joined.includes('air fryer') || joined.includes('airfryer')) add(TAG.airFryer);
    if (joined.includes('קרימי') || joined.includes('creami')) add(TAG.creami);
    if (joined.includes('סלאשי') || joined.includes('slushi')) add(TAG.slushi);

    const predefined = PREDEFINED.filter(t => tags.has(t));
    const custom = [...tags].filter(t => !PREDEFINED.includes(t));
    return [...predefined, ...custom];
  }

  // ---------------------------------------------------------------------------
  // Page parsing for URL imports
  // ---------------------------------------------------------------------------

  /** True when the HTML/text is an anti-bot or error page instead of real content. */
  function isBlockedPage(htmlOrText) {
    const s = String(htmlOrText || '');
    if (s.length < 1500 && !/recipeIngredient/i.test(s)) {
      if (/incapsula|captcha|access denied|request unsuccessful|just a moment|cf-chl|attention required|are you a robot|enable javascript and cookies/i.test(s)) return true;
    }
    return /<title>\s*(just a moment|attention required|access denied)/i.test(s);
  }

  function decodeEntities(str) {
    return String(str || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** "PT1H20M" → 80 (minutes); null if not a duration. */
  function isoDurationMinutes(value) {
    const m = String(value || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
    if (!m) return null;
    const total = (Number(m[1]) || 0) * 1440 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
    return total > 0 ? total : null;
  }

  function flattenInstructions(value) {
    if (!value) return [];
    if (typeof value === 'string') return value.split(/\n+/).map(decodeEntities).filter(Boolean);
    if (Array.isArray(value)) return value.flatMap(flattenInstructions);
    if (typeof value === 'object') {
      if (value.itemListElement) {
        const steps = flattenInstructions(value.itemListElement);
        return value.name && value['@type'] === 'HowToSection' ? [`${decodeEntities(value.name)}:`, ...steps] : steps;
      }
      return [decodeEntities(value.text || value.name || '')].filter(Boolean);
    }
    return [];
  }

  function firstImage(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return firstImage(value[0]);
    return value.url || value.contentUrl || '';
  }

  /**
   * Reads the schema.org Recipe that most recipe sites embed as JSON-LD.
   * @returns {null | {title, description, ingredients: string[], instructions: string[],
   *   prep_time_minutes, image_url, calories, protein_grams, servings}}
   */
  function extractJsonLdRecipe(html) {
    const scripts = [...String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    const nodes = [];
    const collect = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(collect);
      nodes.push(node);
      if (node['@graph']) collect(node['@graph']);
      if (node.mainEntity) collect(node.mainEntity);
    };
    for (const [, raw] of scripts) {
      try { collect(JSON.parse(raw.trim())); } catch { /* skip malformed blocks */ }
    }
    const recipe = nodes.find(n => [].concat(n['@type'] || []).includes('Recipe'));
    if (!recipe) return null;

    const ingredients = [].concat(recipe.recipeIngredient || recipe.ingredients || []).map(decodeEntities).filter(Boolean);
    if (ingredients.length === 0) return null;

    const nutrition = recipe.nutrition || {};
    const time = isoDurationMinutes(recipe.totalTime)
      || ((isoDurationMinutes(recipe.prepTime) || 0) + (isoDurationMinutes(recipe.cookTime) || 0)) || null;
    return {
      title: decodeEntities(recipe.name || ''),
      description: decodeEntities(recipe.description || ''),
      ingredients,
      instructions: flattenInstructions(recipe.recipeInstructions),
      prep_time_minutes: time,
      image_url: firstImage(recipe.image),
      calories: optionalNumber(String(nutrition.calories || '').replace(/[^\d.]/g, ''), v => parseInt(v, 10)),
      protein_grams: optionalNumber(String(nutrition.proteinContent || '').replace(/[^\d.]/g, '')),
      servings: decodeEntities([].concat(recipe.recipeYield || [])[0] || '')
    };
  }

  /** Number, or null when missing / not a positive number (so the UI can show "unknown"). */
  function optionalNumber(value, parse = parseFloat) {
    const n = parse(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  root.RecipeTags = {
    TAG, PREDEFINED, IMPORT_PROMPT, inferTags, canonicalTag, optionalNumber,
    isBlockedPage, extractJsonLdRecipe, isoDurationMinutes
  };
})(typeof window !== 'undefined' ? window : globalThis);
