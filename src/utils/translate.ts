// MyMemory free API — no key required, 5000 chars/day limit
export async function translateToEnglish(text: string): Promise<string> {
  if (!text.trim()) return text;
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=es|en`,
    );
    const data = (await res.json()) as {
      responseData: { translatedText: string };
      responseStatus: number;
    };
    const translated = data.responseData?.translatedText;
    // When the daily quota is used up MyMemory answers 200 with a warning
    // message in place of the translation.
    if (data.responseStatus === 200 && translated && !/MYMEMORY WARNING/i.test(translated)) {
      return translated;
    }
  } catch {
    // fall through — return original if translation fails
  }
  return text;
}

/**
 * Decides the English text to store for a Spanish field.
 * Returns undefined when the stored English text should be left untouched.
 *
 * - An English text edited by the admin always wins.
 * - Otherwise we only call the translator when the Spanish text changed, or
 *   when the stored English is missing / still a copy of the Spanish (left
 *   over from a failed translation).
 */
export async function resolveEnglish(
  next: { es?: string; en?: string },
  prev?: { es: string; en: string },
): Promise<string | undefined> {
  const { es, en } = next;
  if (en && en !== prev?.en) return en;
  if (es === undefined) return undefined;
  if (!es) return '';
  const stale = !prev || es !== prev.es || !prev.en || prev.en === prev.es;
  return stale ? translateToEnglish(es) : undefined;
}
