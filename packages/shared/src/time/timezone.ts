/**
 * True for IANA identifiers the runtime's ICU knows, e.g. "America/Edmonton".
 *
 * ICU alone isn't enough: it also accepts abbreviations like "PST" (silently
 * mapped to America/Los_Angeles), so require the Area/Location shape. Not
 * Intl.supportedValuesOf('timeZone') either: that lists ICU-canonical names
 * only and rejects valid IANA names browsers send, e.g. "Asia/Kolkata".
 *
 * Lives here so the API schemas and @tower-of-habit/db apply the same rule.
 */
export function isValidTimeZone(tz: string): boolean {
  if (tz !== 'UTC' && !tz.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
