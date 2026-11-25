/** Longest Outlook category name that a block carries. */
export const MAX_OUTLOOK_CATEGORY_LENGTH = 100;

/**
 * The value as an Outlook category name, trimmed, or null if Outlook cannot take it: empty, longer
 * than 100 characters, or with a comma. Classic Outlook keeps categories as one comma-separated
 * string and splits a name at its comma.
 */
export function outlookCategoryName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_OUTLOOK_CATEGORY_LENGTH || trimmed.includes(",")) {
    return null;
  }
  return trimmed;
}

/** The value as a Google event colour ID "1" to "11", trimmed, or null if it is none. */
export function googleColorId(value: string): string | null {
  const trimmed = value.trim();
  return /^(?:[1-9]|1[01])$/.test(trimmed) ? trimmed : null;
}
