/**
 * Minimal Gemini API client shared by the browser (classic <script>) and the Node server
 * (imported for its side effect). Exposes globalThis.GeminiClient.
 *
 * Model names change often (2.0 was shut down in 2026), so instead of hardcoding one we ask
 * the API which models this key can use. Calls go to the newest stable "flash" model and fall
 * back to older flash / flash-lite models when Google reports an overload or internal error.
 */
(function (root) {
  const API = 'https://generativelanguage.googleapis.com/v1beta';
  const FALLBACK_MODEL = 'gemini-flash-latest';
  const MAX_MODELS_TO_TRY = 3;
  const modelCache = new Map(); // apiKey -> ordered model names (per page load / server process)

  class GeminiError extends Error {
    constructor(message, status, reason, detail = '') {
      super(message);
      this.status = status;
      this.reason = reason;
      this.detail = detail; // Google's original message, for troubleshooting
    }
  }

  /** Turns an API error into a short Hebrew message the user can act on (+ Google's text). */
  function friendlyMessage(status, apiMessage = '', reason = '') {
    const msg = String(apiMessage);
    const detail = msg ? ` [${status}: ${msg.slice(0, 160)}]` : ` [${status}]`;
    if (reason === 'API_KEY_INVALID' || /api key not valid|API_KEY_INVALID/i.test(msg)) return 'מפתח ה-API לא תקין. בדקי שהעתקת אותו במלואו.';
    if (status === 429) return 'הגעת למגבלת השימוש החינמית של Gemini. נסי שוב בעוד דקה.' + detail;
    if (status === 403) return 'למפתח אין הרשאה ל-Gemini API (ייתכן שצריך להפעיל אותו ב-Google AI Studio).' + detail;
    if (status === 404) return 'המודל לא זמין למפתח הזה.' + detail;
    if (status >= 500) return 'השרת של Gemini לא הצליח לענות. נסי שוב עוד מעט.' + detail;
    return msg || `שגיאת Gemini (${status})`;
  }

  async function request(apiKey, path, init = {}) {
    let res;
    try {
      res = await fetch(`${API}/${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, ...(init.headers || {}) }
      });
    } catch (err) {
      throw new GeminiError('אין חיבור לאינטרנט או ש-Gemini חסום ברשת.', 0, 'NETWORK', String(err && err.message || err));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const apiMessage = data?.error?.message || '';
      const reason = data?.error?.details?.find?.(d => d.reason)?.reason || data?.error?.status || '';
      throw new GeminiError(friendlyMessage(res.status, apiMessage, reason), res.status, reason, apiMessage);
    }
    return data;
  }

  /** Version number from a name like "gemini-3.8-flash" → 3.8 (0 if none). */
  function versionOf(name) {
    const m = name.match(/gemini-(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }

  /** Ordered models to try: newest stable flash first, then older flash, then flash-lite. */
  async function listModels(apiKey, { refresh = false } = {}) {
    if (!refresh && modelCache.has(apiKey)) return modelCache.get(apiKey);
    const data = await request(apiKey, 'models?pageSize=1000');
    const names = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''));
    const byVersion = (a, b) => versionOf(b) - versionOf(a);
    const flash = names.filter(n => /^gemini-\d+(\.\d+)?-flash$/.test(n)).sort(byVersion);
    const lite = names.filter(n => /^gemini-\d+(\.\d+)?-flash-lite$/.test(n)).sort(byVersion);
    const ordered = [...flash, ...lite];
    if (ordered.length === 0) ordered.push(FALLBACK_MODEL);
    modelCache.set(apiKey, ordered);
    return ordered;
  }

  async function resolveModel(apiKey, opts) {
    return (await listModels(apiKey, opts))[0];
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isTransient = err => err.status === 429 || err.status >= 500;

  /**
   * @param {string} apiKey
   * @param {{ systemInstruction?: string, contents: any[], responseSchema?: object, json?: boolean, temperature?: number }} opts
   * @returns {Promise<string>} the model's text (JSON text when json/responseSchema is requested)
   */
  async function generate(apiKey, { systemInstruction, contents, responseSchema, json = !!responseSchema, temperature = 0.4 }) {
    const buildBody = withSchema => {
      const body = {
        contents,
        generationConfig: {
          temperature,
          ...(json ? { responseMimeType: 'application/json' } : {}),
          ...(withSchema && responseSchema ? { responseSchema } : {})
        }
      };
      if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
      return JSON.stringify(body);
    };
    const call = (model, withSchema) => request(apiKey, `models/${model}:generateContent`, {
      method: 'POST',
      body: buildBody(withSchema)
    });

    let models = await listModels(apiKey);
    let refreshed = false;
    let lastError = null;
    let data = null;

    for (let i = 0; i < models.length && i < MAX_MODELS_TO_TRY && !data; i++) {
      const model = models[i];
      // Per model: full request, a short-delay retry, then (if a schema is used) one try without it,
      // since strict schemas occasionally trigger INTERNAL errors on new models.
      const attempts = [{ schema: true, wait: 0 }, { schema: true, wait: 1200 }];
      if (responseSchema) attempts.push({ schema: false, wait: 0 });
      for (const attempt of attempts) {
        if (attempt.wait) await sleep(attempt.wait);
        try {
          data = await call(model, attempt.schema);
          break;
        } catch (err) {
          lastError = err;
          if (err.status === 404 && !refreshed) {
            // Model retired mid-session: refresh the list and start over.
            refreshed = true;
            models = await listModels(apiKey, { refresh: true });
            i = -1;
            break;
          }
          if (!isTransient(err)) throw err;
          // Overload (503) and quota (429) are per model: retrying the same one only adds waiting.
          if (err.status === 429 || err.status === 503) break;
        }
      }
      if (!data && lastError && typeof console !== 'undefined') {
        console.warn(`[Gemini] ${model}:`, lastError.status, lastError.detail || lastError.message);
      }
    }

    if (!data) throw lastError || new GeminiError('Gemini לא ענה.', 0, 'NO_RESPONSE');

    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
    if (!text) {
      const why = candidate?.finishReason || data.promptFeedback?.blockReason || 'EMPTY';
      throw new GeminiError(`Gemini לא החזיר תשובה (${why}). נסי לנסח אחרת.`, 200, why);
    }
    return text;
  }

  /** Parses JSON text, tolerating ```json fences. */
  function parseJson(text) {
    const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const raw = fenced ? fenced[1] : String(text);
    try {
      return JSON.parse(raw);
    } catch {
      const obj = raw.match(/\{[\s\S]*\}/);
      if (obj) return JSON.parse(obj[0]);
      throw new GeminiError('Gemini החזיר תשובה בפורמט לא צפוי.', 200, 'BAD_JSON');
    }
  }

  /** Checks a key by listing models. Resolves to { ok, model } or { ok: false, error }. */
  async function validateKey(apiKey) {
    try {
      const model = await resolveModel(apiKey, { refresh: true });
      return { ok: true, model };
    } catch (err) {
      return { ok: false, error: err.message, status: err.status };
    }
  }

  root.GeminiClient = { generate, parseJson, validateKey, resolveModel, listModels, GeminiError };
})(typeof window !== 'undefined' ? window : globalThis);
