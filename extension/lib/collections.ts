/**
 * Normalises a value that may be a single item, an array, or nullish into an array.
 * Salesforce SOAP/Metadata responses often return a single object where a
 * collection is expected, so feature code uses this to iterate uniformly.
 */
export function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  return [x];
}
