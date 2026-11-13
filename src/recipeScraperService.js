/**
 * Smart Recipe Importer Service (recipeScraperService.js)
 * 
 * Capability:
 * 1. Accepts a URL (Hebrew/English sites, TikTok) or free text (WhatsApp, Instagram captions, notes).
 * 2. If URL: fetches the page, handles TikTok oEmbed or extracts clean body text.
 * 3. Sends raw text to OpenAI API (or Gemini fallback) with the culinary system prompt.
 * 4. Returns strict JSON ready for the 'Add Recipe' modal.
 */

import './public/recipe-tags.js';
import './public/gemini-client.js';

// Shared with the browser so every import path uses the same prompt and tag rules.
const { IMPORT_PROMPT: SYSTEM_PROMPT, inferTags, optionalNumber, isBlockedPage, extractJsonLdRecipe, parseRecipeText } = globalThis.RecipeTags;

/**
 * Checks whether an input string is a valid HTTP/HTTPS URL.
 * @param {string} input 
 * @returns {boolean}
 */
export function isUrl(input) {
  if (!input || typeof input !== 'string') return false;
  const trimmed = input.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Extracts clean, raw readable text from an HTML document body without scripts/styles.
 * @param {string} html 
 * @returns {string}
 */
export function extractTextFromHtml(html) {
  if (!html || typeof html !== 'string') return '';

  // 1. Remove non-content blocks
  let clean = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ');

  // 2. Isolate body content if available
  const bodyMatch = clean.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    clean = bodyMatch[1];
  }

  // 3. Convert block level elements to line breaks
  clean = clean
    .replace(/<(?:p|div|h[1-6]|li|tr|blockquote|article|section)[^>]*>/gi, '\n')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

  // 4. Normalize and trim lines
  const lines = clean
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  // Return limited to first 12,000 characters to keep LLM context dense and cost-efficient
  return lines.join('\n').slice(0, 12000);
}

/**
 * Fetches page text for a given URL, supporting regular websites, TikTok oEmbed, and reader fallback.
 * @param {string} targetUrl 
 * @returns {Promise<{ rawText: string, imageUrl: string, titleHint: string }>}
 */
export async function fetchRawTextFromUrl(targetUrl) {
  const urlObj = new URL(targetUrl);
  const hostname = urlObj.hostname.toLowerCase();

  // Special Handler: TikTok
  if (hostname.includes('tiktok.com')) {
    try {
      const oembedRes = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(targetUrl)}`);
      if (oembedRes.ok) {
        const oembedData = await oembedRes.json();
        const caption = extractTextFromHtml(oembedData.html || '');
        const fullText = [
          `טיקטוק מאת: ${oembedData.author_name || ''}`,
          `כותרת ותיאור: ${oembedData.title || ''}`,
          caption
        ].filter(Boolean).join('\n\n');

        return {
          rawText: fullText,
          imageUrl: oembedData.thumbnail_url || '',
          titleHint: oembedData.title || ''
        };
      }
    } catch {}
  }

  // Standard website fetch. Many recipe sites sit behind anti-bot services that answer with a
  // challenge page (sometimes with status 200), so fall back to the Jina reader, asking it for
  // the raw HTML: that keeps the schema.org Recipe data, which is far more reliable than page text.
  let html = '';
  let directError = null;
  try {
    const response = await fetch(targetUrl, { headers: BROWSER_HEADERS });
    const body = await response.text();
    if (response.ok && !isBlockedPage(body)) html = body;
    else directError = new Error(`האתר חסם את הבקשה (${response.status})`);
  } catch (err) {
    directError = new Error(`לא הצלחתי להתחבר לאתר: ${err.message}`);
  }

  if (!html) {
    try {
      html = await fetchViaReader(targetUrl);
    } catch (err) {
      throw directError || err;
    }
  }

  return parsePageHtml(html);
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'he,en-US,en;q=0.9'
};

/** Fetches a page's HTML through the Jina reader (gets past most anti-bot pages). */
export async function fetchViaReader(targetUrl) {
  const res = await fetch(`https://r.jina.ai/${targetUrl}`, { headers: { 'X-Return-Format': 'html' } });
  const body = res.ok ? await res.text() : '';
  if (!body || isBlockedPage(body)) throw new Error('גם דרך שירות הקריאה האתר חסם את הגישה');
  return body;
}

/** Splits a page into structured recipe data (if present) plus text and hints for the AI. */
export function parsePageHtml(html) {
  const ogImgMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                     html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return {
    structured: extractJsonLdRecipe(html),
    rawText: extractTextFromHtml(html),
    imageUrl: ogImgMatch ? ogImgMatch[1] : '',
    titleHint: titleMatch ? titleMatch[1].split('|')[0].split(' - ')[0].trim() : ''
  };
}

/**
 * Calls OpenAI API (or Gemini / local fallback) with the culinary System Prompt.
 * @param {string} rawText 
 * @param {object} options 
 * @returns {Promise<object>}
 */
export async function parseRecipeWithLlm(rawText, options = {}) {
  const providedKey = (options.apiKey || '').trim();
  // The browser says which provider the key is for; the prefix check only covers older callers
  // (newer Google keys don't start with "AIza").
  const isGeminiKey = options.provider === 'gemini' || providedKey.startsWith('AIza');
  const openaiApiKey = (!isGeminiKey ? providedKey : '') || options.openaiApiKey || process.env.OPENAI_API_KEY;
  const geminiApiKey = (isGeminiKey ? providedKey : '') || options.geminiApiKey || process.env.GEMINI_API_KEY;

  // 1. Try OpenAI if API key available
  if (openaiApiKey) {
    try {
      const model = options.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`
        },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: rawText }
          ],
          temperature: 0.1
        })
      });

      if (res.ok) {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          return sanitizeRecipeOutput(parsed);
        }
      }
    } catch (e) {
      console.warn('OpenAI parser error, attempting fallback:', e.message);
    }
  }

  // 2. Try Gemini API fallback if Gemini key available
  if (geminiApiKey) {
    try {
      // GeminiClient picks a model the key can actually use (hardcoded names get retired).
      const text = await globalThis.GeminiClient.generate(geminiApiKey, {
        systemInstruction: SYSTEM_PROMPT,
        contents: [{ role: 'user', parts: [{ text: `הטקסט לניתוח:\n${rawText}` }] }],
        json: true,
        temperature: 0.1
      });
      return sanitizeRecipeOutput(globalThis.GeminiClient.parseJson(text));
    } catch (e) {
      console.warn('Gemini parser error, using text-only fallback:', e.message);
    }
  }

  // 3. Fallback Heuristic Parser (Ensures zero crashes even without any LLM keys configured)
  return heuristicFallbackParser(rawText);
}

/**
 * Sanitizes and normalizes LLM JSON output to conform to application schema.
 * @param {object} parsed 
 * @returns {object}
 */
function sanitizeRecipeOutput(parsed) {
  const title = String(parsed.title || 'מתכון חדש').trim();

  // Ingredients: ensure array of strings
  let ingredients = [];
  if (Array.isArray(parsed.ingredients)) {
    ingredients = parsed.ingredients.map(i => {
      if (typeof i === 'string') return i.trim();
      if (typeof i === 'object' && i !== null) {
        return `${i.amount || ''} ${i.unit || ''} ${i.name || ''}`.trim();
      }
      return String(i);
    }).filter(Boolean);
  }

  // Instructions: ensure array of strings
  let instructions = [];
  if (Array.isArray(parsed.instructions)) {
    instructions = parsed.instructions.map(s => String(s).trim()).filter(Boolean);
  } else if (typeof parsed.instructions === 'string') {
    instructions = parsed.instructions.split('\n').map(s => s.trim()).filter(Boolean);
  }

  // Unknown values stay null so the form shows them as empty instead of inventing numbers.
  const prep_time_minutes = optionalNumber(parsed.prep_time_minutes, v => parseInt(v, 10));
  const calories = optionalNumber(parsed.calories, v => parseInt(v, 10));
  const protein_grams = optionalNumber(parsed.protein_grams);

  const tags = inferTags(
    { title, ingredients, instructions, protein_grams },
    Array.isArray(parsed.tags) ? parsed.tags : []
  );

  return {
    title,
    ingredients,
    instructions,
    prep_time_minutes,
    tags,
    description: String(parsed.description || '').trim(),
    calories,
    protein_grams,
    difficulty: ['קל', 'בינוני', 'קשה'].includes(parsed.difficulty) ? parsed.difficulty : 'בינוני'
  };
}

export { sanitizeRecipeOutput };

/**
 * Heuristic parser used when no external LLM API key is present.
 * @param {string} rawText 
 * @returns {object}
 */
function heuristicFallbackParser(rawText) {
  // Same parser the browser uses (handles Google Keep notes with or without headers).
  const parsed = parseRecipeText(rawText) || { title: 'מתכון מיובא', ingredients: [], instructions: [], description: '', prep_time_minutes: null };
  const { title, ingredients, instructions } = parsed;

  // No AI available: keep only what the text actually says; leave nutrition blank for the user.
  return {
    title,
    ingredients,
    instructions,
    prep_time_minutes: parsed.prep_time_minutes,
    tags: inferTags({ title, ingredients, instructions }),
    description: parsed.description,
    calories: null,
    protein_grams: null,
    difficulty: 'בינוני'
  };
}

/**
 * Main function: imports and parses recipe from either a URL or free text.
 * @param {string} input 
 * @param {object} options 
 * @returns {Promise<object>}
 */
export async function importRecipe(input, options = {}) {
  if (!input || typeof input !== 'string') {
    throw new Error('Input must be a non-empty string (either a valid URL or free text recipe).');
  }

  const trimmed = input.trim();
  let textToParse = trimmed;
  let sourceUrl = '';
  let detectedImageUrl = '';

  if (isUrl(trimmed)) {
    sourceUrl = trimmed;
    const page = await fetchRawTextFromUrl(trimmed);
    if (page.structured) {
      return buildFromStructuredRecipe(page.structured, { sourceUrl, ogImage: page.imageUrl, options });
    }
    if (!page.rawText || page.rawText.length < 200) {
      throw new Error('לא נמצא תוכן מתכון בעמוד');
    }
    textToParse = `מקור URL: ${trimmed}\nכותרת עמוד: ${page.titleHint}\n\nתוכן העמוד:\n${page.rawText}`;
    detectedImageUrl = page.imageUrl;
  }

  const recipe = await parseRecipeWithLlm(textToParse, options);

  if (sourceUrl && recipe.ingredients.length === 0) {
    // Better a clear error than a form full of navigation-menu junk.
    throw new Error('לא הצלחתי למצוא מצרכים בעמוד');
  }
  if (sourceUrl) recipe.source_url = sourceUrl;
  if (detectedImageUrl) recipe.image_url = detectedImageUrl;

  return recipe;
}

/**
 * Builds the recipe from the site's own schema.org data (exact ingredients and steps).
 * The AI, when available, only fills what sites rarely include: calorie/protein estimates,
 * difficulty and tags.
 */
export async function buildFromStructuredRecipe(s, { sourceUrl = '', ogImage = '', options = {} } = {}) {
  const summary = [
    `שם: ${s.title}`,
    s.servings ? `כמות: ${s.servings}` : '',
    'מצרכים:',
    ...s.ingredients.map(i => `- ${i}`),
    'אופן הכנה:',
    ...s.instructions.map((step, n) => `${n + 1}. ${step}`)
  ].filter(Boolean).join('\n');

  let ai = {};
  try {
    ai = await parseRecipeWithLlm(summary, options);
  } catch {
    ai = {};
  }

  const title = s.title || ai.title || 'מתכון מיובא';
  const protein_grams = s.protein_grams ?? ai.protein_grams ?? null;
  return {
    title,
    description: s.description || ai.description || '',
    ingredients: s.ingredients,
    instructions: s.instructions,
    prep_time_minutes: s.prep_time_minutes ?? ai.prep_time_minutes ?? null,
    calories: s.calories ?? ai.calories ?? null,
    protein_grams,
    difficulty: ai.difficulty || 'בינוני',
    tags: inferTags({ title, ingredients: s.ingredients, instructions: s.instructions, protein_grams }, ai.tags || []),
    image_url: s.image_url || ogImage || '',
    source_url: sourceUrl,
    fromStructuredData: true
  };
}

export default {
  importRecipe,
  isUrl,
  fetchRawTextFromUrl,
  extractTextFromHtml,
  parseRecipeWithLlm
};
