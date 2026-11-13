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
title (String), description (String, משפט או שניים), ingredients (Array of strings, כל מצרך בפריט נפרד בפורמט "כמות יחידה שם", למשל "2 כוסות קמח" או "1/2 כפית מלח"; מצרך בלי כמות - רק השם), instructions (Array of strings), prep_time_minutes (Number), difficulty ("קל" / "בינוני" / "קשה"),
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

  // ---------------------------------------------------------------------------
  // Free-text recipes (Google Keep shares, pasted notes)
  // ---------------------------------------------------------------------------

  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Keep checkboxes, bullets and "1." / "2)" step numbers at the start of a line ("1.5 כוסות" is kept).
  const LINE_MARKER = /^\s*(?:[☐☑☒✓✔✗✘□■▢◻◼▪▫●○◦•·*>\-–—]+|\d{1,2}[.)](?![\d/]))\s*/;
  const CHECKBOX = /^\s*[☐☑☒□▢◻]/;
  const NUMBERED = /^\s*\d{1,2}[.)](?![\d/])/;

  const UNITS = ['כוסות', 'כוס', 'כוסית', 'כפות', 'כף', 'כפיות', 'כפית', 'גרמים', 'גרם', "גר'", 'גר', "ג'", 'ג',
    'קילוגרם', 'קילו', 'ק"ג', 'קג', 'ליטרים', 'ליטר', 'מ"ל', 'מל', 'יחידות', 'יחידה', "יח'",
    'חבילות', 'חבילה', 'חבילת', 'קופסאות', 'קופסות', 'קופסה', 'קופסת', 'שקיות', 'שקית', 'פחיות', 'פחית',
    'שיני', 'שן', 'צרורות', 'צרור', 'קורט', 'קמצוץ', 'חופנים', 'חופן', 'פרוסות', 'פרוסה', 'ענפי', 'ענף',
    'גבעולי', 'גבעול', 'עלי', 'גביעים', 'גביע', 'מיכל', 'מכל', 'בקבוק', 'ראשי', 'ראש', 'קוביות', 'קוביה',
    'ml', 'kg', 'gr', 'g', 'cups', 'cup', 'tbsp', 'tsp', 'oz', 'lbs', 'lb'];
  // Units that may open a line without a number ("כף שמן זית" = 1 כף).
  const BARE_UNITS = new Set(['כוס', 'כוסית', 'כף', 'כפית', 'קופסה', 'קופסת', 'חבילה', 'חבילת', 'שקית', 'פחית',
    'צרור', 'גביע', 'מיכל', 'מכל', 'בקבוק', 'ראש', 'שן', 'ענף', 'פרוסה', 'קורט', 'קמצוץ', 'חופן']);
  const NO_COUNT_UNITS = new Set(['קורט', 'קמצוץ', 'חופן']);
  const NUMBER_WORDS = {
    'חצי': '1/2', 'רבע': '1/4', 'שליש': '1/3', 'אחד': '1', 'אחת': '1', 'שני': '2', 'שתי': '2', 'שניים': '2',
    'שתיים': '2', 'שלוש': '3', 'שלושה': '3', 'ארבע': '4', 'ארבעה': '4', 'חמש': '5', 'חמישה': '5',
    'שש': '6', 'שישה': '6', 'שבע': '7', 'שבעה': '7', 'שמונה': '8', 'עשר': '10', 'עשרה': '10'
  };
  const FRACTIONS = { '½': '1/2', '¼': '1/4', '¾': '3/4', '⅓': '1/3', '⅔': '2/3', '⅛': '1/8' };

  const byLength = list => [...list].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?\s?[½¼¾⅓⅔⅛]?|[½¼¾⅓⅔⅛])(?:\s*[-–]\s*(?:\d+\/\d+|\d+(?:[.,]\d+)?))?`;
  const AMOUNT = `(?:${NUM}(?![\\d/])|(?:${byLength(Object.keys(NUMBER_WORDS))})(?=\\s|$))`;
  const UNIT_ALT = byLength(UNITS);
  const LEAD_RE = new RegExp(`^(?:כ[-־]\\s?|~\\s?)?(${AMOUNT})\\s*`);
  const UNIT_RE = new RegExp(`^(${UNIT_ALT})(?=$|[\\s,.;:)])`, 'i');
  const TAIL_RE = new RegExp(`^(.+?)(?:\\s*[-–—:,]\\s*|\\s+)(${AMOUNT})(?:\\s*(${UNIT_ALT}))?\\s*\\.?$`, 'i');
  const TIME_HINT = /\d+\s*(?:דקות|דקה|דק'|שעה|שעות|מעלות)|°|תנור|minutes/i;

  function normalizeLine(line) {
    return String(line || '')
      .replace(/[‎‏‪-‮⁦-⁩﻿]/g, '') // bidi marks Android/Keep add
      .replace(/׳/g, "'").replace(/״/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripMarker(line) {
    let out = String(line || '');
    for (let prev = null; out && out !== prev;) { prev = out; out = out.replace(LINE_MARKER, ''); }
    return out.trim();
  }

  function cleanAmount(a) {
    const s = String(a || '').trim();
    if (NUMBER_WORDS[s]) return NUMBER_WORDS[s];
    return s.replace(/\s*([½¼¾⅓⅔⅛])/g, (_, f) => ` ${FRACTIONS[f]}`).replace(/\s*[-–]\s*/, '-').trim();
  }

  /**
   * "2 כוסות קמח" → { name: 'קמח', amount: '2', unit: 'כוסות' }. Also handles "חצי כוס סוכר",
   * "1½ כפיות מלח", "כף שמן זית", "קמח - 2 כוסות". Unrecognized lines come back whole as the name.
   */
  function splitIngredient(raw) {
    const original = stripMarker(normalizeLine(raw));
    let rest = original;
    let amount = '';
    let unit = '';

    const lead = rest.match(LEAD_RE);
    if (lead) {
      amount = cleanAmount(lead[1]);
      rest = rest.slice(lead[0].length);
    }
    const u = rest.match(UNIT_RE);
    if (u && (amount || BARE_UNITS.has(u[1]))) {
      unit = u[1];
      rest = rest.slice(u[0].length);
      if (!amount && !NO_COUNT_UNITS.has(unit)) amount = '1';
    }
    if (!amount) {
      const tail = rest.match(TAIL_RE);
      if (tail) {
        rest = tail[1];
        amount = cleanAmount(tail[2]);
        unit = tail[3] || '';
      }
    }
    rest = rest.replace(/^[\s,.:\-–]+|[\s,:\-–]+$/g, '').replace(/^של\s+/, '').trim();
    if (!rest) return { name: original, amount: '', unit: '' };
    return { name: rest, amount, unit };
  }

  const ING_HEADER = /^(?:רשימת\s+)?(?:ה?מצרכים|ה?מרכיבים|ה?רכיבים|חומרים|מה צריך|ingredients?)(?=$|[\s:(\-–])/i;
  const INST_HEADER = /^(?:אופן\s+ה?הכנה|דרך\s+ה?הכנה|שלבי\s+ה?הכנה|הוראות(?:\s+ה?הכנה)?|ה?הכנה|instructions?|method|directions|preparation|steps)(?=$|[\s:(\-–])/i;
  const PREP_TIME = /^זמן\s*(?:הכנה|כולל|בישול|אפייה)?\s*[:\-–]?\s*(\d+)\s*(דקות|דק'|דק|שעה|שעות|minutes|min)/i;

  /** "מצרכים:" / "אופן הכנה" / "Ingredients: 2 eggs, salt" → { kind, rest } or null. */
  function headerOf(line) {
    const colon = line.indexOf(':');
    const head = (colon >= 0 ? line.slice(0, colon) : line).replace(/[^\p{L}\p{N}\s()'"\-–]/gu, '').trim();
    if (!head || head.split(/\s+/).length > 5) return null;
    const kind = ING_HEADER.test(head) ? 'ing' : INST_HEADER.test(head) ? 'inst' : null;
    if (!kind) return null;
    return { kind, rest: colon >= 0 ? line.slice(colon + 1).trim() : '' };
  }

  function looksLikeIngredient(entry) {
    const { line } = entry;
    const words = line.split(' ').length;
    if (TIME_HINT.test(line)) return false;
    if (LEAD_RE.test(line) || (UNIT_RE.test(line) && BARE_UNITS.has(line.match(UNIT_RE)[1]))) return words <= 12;
    if (entry.numbered && words > 4) return false;
    if (/[.!]$/.test(line) && words > 3) return false;
    if (entry.checkbox) return words <= 10;
    if (words <= 4) return true;
    const s = splitIngredient(line);
    return Boolean(s.amount) && words <= 9;
  }

  /** "2 ביצים, כוס קמח, מלח" → three ingredients; "קוטג', לבנה או סימפוניה" stays one. */
  function splitIngredientList(line) {
    const parts = line.split(/\s*[,،]\s*/).filter(Boolean);
    const short = parts.every(p => p.split(' ').length <= 5);
    if (parts.length >= 3 && short) return parts;
    if (parts.length === 2 && parts.every(p => p.split(' ').length <= 2) && !/(^|\s)או(\s|$)/.test(line)) return parts;
    return [line];
  }

  /**
   * Heuristic recipe parser for free text (no AI). Works with or without "מצרכים"/"הכנה" headers:
   * without them, short / quantity lines before the first sentence-like line are ingredients.
   * Ingredients are returned as strings ("2 כוסות קמח"); splitIngredient() breaks them into fields.
   */
  function parseRecipeText(text) {
    const lines = String(text || '').split(/\r?\n/).map(normalizeLine).filter(Boolean);
    if (lines.length === 0) return null;

    const firstIsHeader = headerOf(stripMarker(lines[0]));
    const title = firstIsHeader ? '' : stripMarker(lines[0]).replace(/^#+\s*/, '').slice(0, 80);
    const body = (firstIsHeader ? lines : lines.slice(1)).map(raw => {
      const line = stripMarker(raw);
      return { line, checkbox: CHECKBOX.test(raw), numbered: NUMBERED.test(raw), header: headerOf(line) };
    }).filter(e => e.line);

    const ingredients = [];
    const instructions = [];
    const desc = [];
    let prep = null;
    let section = body.some(e => e.header && e.header.kind === 'ing') ? 'desc' : 'auto';
    let seenStep = false;

    const place = entry => {
      const { line } = entry;
      const time = line.match(PREP_TIME);
      if (time) {
        prep = Number(time[1]) * (/שע|hour/.test(time[2]) ? 60 : 1);
        return;
      }
      if (section === 'ing') {
        // Keep notes often run straight from the ingredients into the steps without a header.
        if (!looksLikeIngredient(entry) && line.split(' ').length >= 6) {
          section = 'inst';
          instructions.push(line);
        } else {
          ingredients.push(...splitIngredientList(line));
        }
      } else if (section === 'inst') {
        instructions.push(line);
      } else if (section === 'desc') {
        desc.push(line);
      } else if (!seenStep && looksLikeIngredient(entry)) {
        ingredients.push(...splitIngredientList(line));
      } else {
        seenStep = true;
        instructions.push(line);
      }
    };

    for (const entry of body) {
      if (entry.header) {
        section = entry.header.kind;
        if (entry.header.rest) place({ ...entry, line: entry.header.rest });
        continue;
      }
      place(entry);
    }

    return {
      title: title || 'מתכון מטקסט',
      description: desc.slice(0, 3).join(' '),
      ingredients,
      instructions,
      prep_time_minutes: prep,
      calories: null,
      protein_grams: null,
      difficulty: 'בינוני'
    };
  }

  root.RecipeTags = {
    TAG, PREDEFINED, IMPORT_PROMPT, inferTags, canonicalTag, optionalNumber,
    isBlockedPage, extractJsonLdRecipe, isoDurationMinutes, splitIngredient, parseRecipeText
  };
})(typeof window !== 'undefined' ? window : globalThis);
