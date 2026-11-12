/**
 * Smart Recipe Importer Service (recipeScraperService.js)
 * 
 * Capability:
 * 1. Accepts a URL (Hebrew/English sites, TikTok) or free text (WhatsApp, Instagram captions, notes).
 * 2. If URL: fetches the page, handles TikTok oEmbed or extracts clean body text.
 * 3. Sends raw text to OpenAI API (or Gemini fallback) with the culinary system prompt.
 * 4. Returns strict JSON ready for the 'Add Recipe' modal.
 */

const SYSTEM_PROMPT = `אתה עוזר קולינרי. קבל את הטקסט הבא וחלץ ממנו את המתכון למבנה JSON מחמיר הכולל: title (String), ingredients (Array of strings), instructions (Array of strings), prep_time_minutes (Number). בנוסף, הוסף מערך של tags וכלול בו תגיות רלוונטיות אם זיהית אותן (למשל: עתיר חלבון, צמחוני, מנות דגים, דל סוכר, נינג'ה אייר פרייר, ללא סלטים).`;

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

  // Standard Website fetch
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'he,en-US,en;q=0.9'
  };

  let response;
  try {
    response = await fetch(targetUrl, { headers });
  } catch (err) {
    // Fallback: Jina Reader Proxy for sites with SSL or network blocks
    const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
      headers: { 'Accept': 'text/plain' }
    });
    if (jinaRes.ok) {
      const jinaText = await jinaRes.text();
      return {
        rawText: jinaText.slice(0, 12000),
        imageUrl: '',
        titleHint: ''
      };
    }
    throw new Error(`Failed to fetch URL: ${err.message}`);
  }

  // If website responds with anti-bot challenge (403/429), try reader proxy
  if (!response.ok && (response.status === 403 || response.status === 429)) {
    try {
      const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers: { 'Accept': 'text/plain' }
      });
      if (jinaRes.ok) {
        const jinaText = await jinaRes.text();
        return {
          rawText: jinaText.slice(0, 12000),
          imageUrl: '',
          titleHint: ''
        };
      }
    } catch {}
    throw new Error(`Website blocked request (${response.status} ${response.statusText})`);
  }

  const html = await response.text();

  // Extract metadata hints
  let imageUrl = '';
  const ogImgMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                     html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogImgMatch) imageUrl = ogImgMatch[1];

  let titleHint = '';
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) titleHint = titleMatch[1].split('|')[0].split('-')[0].trim();

  const rawText = extractTextFromHtml(html);
  return { rawText, imageUrl, titleHint };
}

/**
 * Calls OpenAI API (or Gemini / local fallback) with the culinary System Prompt.
 * @param {string} rawText 
 * @param {object} options 
 * @returns {Promise<object>}
 */
export async function parseRecipeWithLlm(rawText, options = {}) {
  const openaiApiKey = options.apiKey || options.openaiApiKey || process.env.OPENAI_API_KEY;
  const geminiApiKey = options.geminiApiKey || process.env.GEMINI_API_KEY;

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
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: `${SYSTEM_PROMPT}\n\nהטקסט לניתוח:\n${rawText}` }]
          }]
        })
      });

      if (geminiRes.ok) {
        const data = await geminiRes.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          return sanitizeRecipeOutput(parsed);
        }
      }
    } catch (e) {
      console.warn('Gemini parser error, attempting heuristic fallback:', e.message);
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

  // Prep time
  const prep_time_minutes = parseInt(parsed.prep_time_minutes, 10) || 15;

  // Tags
  let tags = [];
  if (Array.isArray(parsed.tags)) {
    tags = parsed.tags.map(t => String(t).trim()).filter(Boolean);
  }

  // Auto-detect nutritional tags if not present
  const fullText = (title + ' ' + ingredients.join(' ') + ' ' + instructions.join(' ')).toLowerCase();
  const ensureTag = (tag) => { if (!tags.includes(tag)) tags.push(tag); };

  if (fullText.includes('סלמון') || fullText.includes('טונה') || fullText.includes('דג') || fullText.includes('salmon')) {
    ensureTag('מנות דגים');
  } else if (!fullText.includes('בשר') && !fullText.includes('עוף')) {
    ensureTag('צמחוני');
  }

  if (fullText.includes('אייר פרייר') || fullText.includes('air fryer')) ensureTag('נינג\'ה אייר פרייר');
  if (fullText.includes('קרימי') || fullText.includes('creami')) ensureTag('מתאים לנינג\'ה קרימי');
  if (fullText.includes('סלאשי') || fullText.includes('slushi')) ensureTag('מתאים לנינג\'ה סלאשי');
  if (!fullText.includes('סוכר')) ensureTag('דל סוכר');
  if (fullText.includes('חלבון') || fullText.includes('protein')) ensureTag('עתיר חלבון');
  if (!fullText.includes('כוסברה')) ensureTag('ללא כוסברה');
  if (!fullText.includes('סלט')) ensureTag('ללא סלטים');

  return {
    title,
    ingredients,
    instructions,
    prep_time_minutes,
    tags,
    description: parsed.description || `מתכון יובא בהצלחה עבור ${title}`,
    calories: parseInt(parsed.calories, 10) || 350,
    protein_grams: parseFloat(parsed.protein_grams) || 25,
    difficulty: parsed.difficulty || 'בינוני'
  };
}

/**
 * Heuristic parser used when no external LLM API key is present.
 * @param {string} rawText 
 * @returns {object}
 */
function heuristicFallbackParser(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  let title = lines[0] ? lines[0].replace(/^[#*•\-\d.\s]+/, '').slice(0, 80) : 'מתכון מיובא';

  let section = 'desc';
  const ingredients = [];
  const instructions = [];
  const desc = [];

  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    const low = l.toLowerCase();

    if (l.includes('מצרכים') || l.includes('מרכיבים') || l.includes('חומרים') || low.includes('ingredient')) {
      section = 'ing';
      continue;
    }
    if (l.includes('הכנה') || l.includes('הוראות') || low.includes('instruction') || low.includes('method') || low.includes('direction')) {
      section = 'inst';
      continue;
    }

    if (section === 'ing') {
      const cleanIng = l.replace(/^[-*•\d.]+\s*/, '').trim();
      if (cleanIng.length > 1) ingredients.push(cleanIng);
    } else if (section === 'inst') {
      const cleanInst = l.replace(/^[-*•\d.]+\s*/, '').trim();
      if (cleanInst.length > 2) instructions.push(cleanInst);
    } else {
      desc.push(l);
    }
  }

  const tags = ['דל סוכר', 'עתיר חלבון', 'ללא כוסברה'];
  const full = (title + ' ' + rawText).toLowerCase();
  if (full.includes('סלמון') || full.includes('דג') || full.includes('טונה')) tags.push('מנות דגים');
  else tags.push('צמחוני');
  if (full.includes('אייר פרייר')) tags.push('נינג\'ה אייר פרייר');

  return {
    title,
    ingredients: ingredients.length > 0 ? ingredients : ['מצרך 1'],
    instructions: instructions.length > 0 ? instructions : ['אופן הכנה מפורט בטקסט המקורי'],
    prep_time_minutes: 15,
    tags,
    description: desc.slice(0, 2).join(' ') || 'מתכון שיובא מטקסט חופשי',
    calories: 360,
    protein_grams: 28,
    difficulty: 'קל'
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
    const { rawText, imageUrl, titleHint } = await fetchRawTextFromUrl(trimmed);
    textToParse = `מקור URL: ${trimmed}\nכותרת עמוד: ${titleHint}\n\nתוכן העמוד:\n${rawText}`;
    detectedImageUrl = imageUrl;
  }

  const recipe = await parseRecipeWithLlm(textToParse, options);

  if (sourceUrl) recipe.source_url = sourceUrl;
  if (detectedImageUrl) recipe.image_url = detectedImageUrl;

  return recipe;
}

export default {
  importRecipe,
  isUrl,
  fetchRawTextFromUrl,
  extractTextFromHtml,
  parseRecipeWithLlm
};
