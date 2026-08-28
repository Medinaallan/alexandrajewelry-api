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
    if (data.responseStatus === 200) return data.responseData.translatedText;
  } catch {
    // fall through — return original if translation fails
  }
  return text;
}
