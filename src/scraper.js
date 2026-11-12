/**
 * Scrapes and extracts recipe data from a given web URL.
 * Handles schema.org Recipe (JSON-LD) and OpenGraph / meta tag fallbacks.
 */

function parseIsoDuration(duration) {
  if (!duration || typeof duration !== 'string') return 0;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  return (hours * 60) + minutes;
}

function parseNumeric(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  const num = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return isNaN(num) ? 0 : Math.round(num);
}

function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function scrapeRecipeFromUrl(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'he,en-US,en;q=0.9'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch recipe from URL: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();

  let recipeData = {
    title: '',
    description: '',
    instructions: '',
    ingredients: [],
    imageUrl: '',
    prepTimeMinutes: 0,
    calories: 0,
    proteinGrams: 0,
    sourceUrl: url
  };

  // 1. Try finding JSON-LD blocks
  const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatches) {
    for (const match of jsonLdMatches) {
      try {
        const jsonContent = match.replace(/<script[^>]*>|<\/script>/gi, '').trim();
        const parsed = JSON.parse(jsonContent);

        const findRecipeObject = (obj) => {
          if (!obj) return null;
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const res = findRecipeObject(item);
              if (res) return res;
            }
          } else if (typeof obj === 'object') {
            const type = obj['@type'];
            if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) {
              return obj;
            }
            if (obj['@graph'] && Array.isArray(obj['@graph'])) {
              return findRecipeObject(obj['@graph']);
            }
          }
          return null;
        };

        const recipeObj = findRecipeObject(parsed);
        if (recipeObj) {
          recipeData.title = cleanText(recipeObj.name || recipeObj.headline || '');
          recipeData.description = cleanText(recipeObj.description || '');

          // Ingredients
          const rawIngredients = recipeObj.recipeIngredient || recipeObj.ingredients || [];
          if (Array.isArray(rawIngredients)) {
            recipeData.ingredients = rawIngredients.map(ing => {
              const cleaned = cleanText(ing);
              return { name: cleaned, amount: '', unit: '' };
            });
          }

          // Instructions
          const rawInstructions = recipeObj.recipeInstructions;
          if (Array.isArray(rawInstructions)) {
            recipeData.instructions = rawInstructions.map((step, idx) => {
              if (typeof step === 'string') return `${idx + 1}. ${cleanText(step)}`;
              if (step && step.text) return `${idx + 1}. ${cleanText(step.text)}`;
              return '';
            }).filter(Boolean).join('\n');
          } else if (typeof rawInstructions === 'string') {
            recipeData.instructions = cleanText(rawInstructions);
          }

          // Media / Image
          if (recipeObj.image) {
            if (typeof recipeObj.image === 'string') recipeData.imageUrl = recipeObj.image;
            else if (Array.isArray(recipeObj.image) && recipeObj.image[0]) {
              recipeData.imageUrl = typeof recipeObj.image[0] === 'string' ? recipeObj.image[0] : (recipeObj.image[0].url || '');
            } else if (recipeObj.image.url) {
              recipeData.imageUrl = recipeObj.image.url;
            }
          }

          // Time
          const duration = recipeObj.totalTime || recipeObj.prepTime || recipeObj.cookTime;
          recipeData.prepTimeMinutes = parseIsoDuration(duration);

          // Nutrition
          if (recipeObj.nutrition) {
            recipeData.calories = parseNumeric(recipeObj.nutrition.calories);
            recipeData.proteinGrams = parseNumeric(recipeObj.nutrition.proteinContent);
          }

          break; // Found primary recipe
        }
      } catch {
        // Continue to next block if JSON parsing fails
      }
    }
  }

  // 2. Fallbacks with meta tags if fields are still empty
  if (!recipeData.title) {
    const titleMatch = html.match(/<meta property=["']og:title["'] content=["'](.*?)["']/i) ||
                       html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch) recipeData.title = cleanText(titleMatch[1]);
  }

  if (!recipeData.description) {
    const descMatch = html.match(/<meta property=["']og:description["'] content=["'](.*?)["']/i) ||
                      html.match(/<meta name=["']description["'] content=["'](.*?)["']/i);
    if (descMatch) recipeData.description = cleanText(descMatch[1]);
  }

  if (!recipeData.imageUrl) {
    const imgMatch = html.match(/<meta property=["']og:image["'] content=["'](.*?)["']/i);
    if (imgMatch) recipeData.imageUrl = imgMatch[1];
  }

  return recipeData;
}
