/**
 * Matching and cross-referencing algorithm between Recipes and Pantry (Listi).
 */

/**
 * Normalizes text for lenient matching (e.g., handles "סלמון טרי" vs "סלמון")
 */
function normalizeString(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Determines whether a recipe ingredient is satisfied by an item currently in the pantry
 */
export function isIngredientInPantry(recipeIngredientName, pantryItems) {
  const normRecipeIng = normalizeString(recipeIngredientName);
  if (!normRecipeIng) return false;

  return pantryItems.some(p => {
    // Must be in stock in the pantry
    if (p.status !== 'במזווה') return false;
    const normPantry = normalizeString(p.item_name);
    if (!normPantry) return false;

    // Direct inclusion in either direction
    return normRecipeIng.includes(normPantry) || normPantry.includes(normRecipeIng);
  });
}

/**
 * Evaluates all recipes against the current pantry inventory.
 * Computes match percentage and segregates matched vs missing ingredients.
 */
export function calculateRecipeMatches(recipes, pantryRows) {
  return recipes.map(recipe => {
    let rawIngredients = [];
    try {
      rawIngredients = typeof recipe.ingredients === 'string'
        ? JSON.parse(recipe.ingredients || '[]')
        : (recipe.ingredients || []);
    } catch {
      rawIngredients = [];
    }

    const totalCount = rawIngredients.length;
    const matched = [];
    const missing = [];

    if (totalCount === 0) {
      return {
        ...recipe,
        total_ingredients_count: 0,
        matched_count: 0,
        missing_count: 0,
        match_percentage: 100,
        matched_ingredients: [],
        missing_ingredients: []
      };
    }

    for (const ing of rawIngredients) {
      const ingName = typeof ing === 'object' ? (ing.name || '') : String(ing);
      const isAvailable = isIngredientInPantry(ingName, pantryRows);

      if (isAvailable) {
        matched.push(ing);
      } else {
        missing.push(ing);
      }
    }

    const matchPercentage = Math.round((matched.length / totalCount) * 100);

    return {
      ...recipe,
      total_ingredients_count: totalCount,
      matched_count: matched.length,
      missing_count: missing.length,
      match_percentage: matchPercentage,
      matched_ingredients: matched,
      missing_ingredients: missing
    };
  }).sort((a, b) => {
    // Sort 100% matches first, then lowest missing count, then highest protein
    if (b.match_percentage !== a.match_percentage) {
      return b.match_percentage - a.match_percentage;
    }
    if (a.missing_count !== b.missing_count) {
      return a.missing_count - b.missing_count;
    }
    return (b.protein_grams || 0) - (a.protein_grams || 0);
  });
}
