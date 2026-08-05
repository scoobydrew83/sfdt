// "Is this cell value a Salesforce record Id?"
//
// Extracted from features/soql-runner.ts, where it decided which result cells
// get the record-actions menu. C-P4-2 needs the SAME answer for a much less
// forgiving purpose — which rows a bulk delete is allowed to touch — and two
// copies of a predicate that gates a destructive action is exactly the kind of
// duplication that drifts. One definition, two callers.
//
// The length test alone is not enough: an 18-character API name, a base-62
// external id, or a hash column would all pass it. The two extra conditions are
// the heuristics that shipped with the menu and are kept verbatim:
//
//   - `000…` is the Salesforce null/blank key prefix, never a real record.
//   - A real Id starts with a three-character key prefix that always contains a
//     digit, followed by a 2-character pod id that usually does — so requiring
//     at least one digit in the first five characters rejects all-alpha words
//     of the right length ("DescriptionField") without rejecting real Ids.
//
// This is deliberately CONSERVATIVE: a false negative costs one row that the
// user can delete by narrowing the query, a false positive costs an API call
// against an id that does not exist. Neither deletes the wrong record — the
// object name comes from the query result's own `attributes.type`, not from
// parsing the Id's key prefix.
//
// Returns a plain boolean rather than a `value is string` predicate on purpose:
// the SOQL runner asks it about a value already typed `string`, and a type
// guard there would narrow the ELSE branch to `never` and break the ordinary
// "not an Id, render it as text" path.
export function isRecordId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[a-zA-Z0-9]{15,18}$/.test(value) &&
    !value.startsWith('000') &&
    /[0-9]/.test(value.slice(0, 5))
  );
}
