/**
 * Shared constants for /privacy and /terms so the two pages cannot drift on the
 * entity name, the effective date or the contact route.
 *
 * `EFFECTIVE_DATE` is the date the current text took effect. Bump it only when
 * the substance changes — a typo fix is not a new policy.
 */
export const ENTITY = "Hallows Group LLC";
export const ENTITY_JURISDICTION = "Texas, United States";
export const EFFECTIVE_DATE = "13 October 2026";
export const REPO_URL = "https://github.com/scoobydrew83/sfdt";
export const ISSUES_URL = "https://github.com/scoobydrew83/sfdt/issues";
export const SECURITY_URL =
  "https://github.com/scoobydrew83/sfdt/security/advisories/new";

/**
 * The private contact route. A privacy policy needs one that is not a public
 * issue tracker: a data-subject request, a deletion demand or a store reviewer's
 * question must not have to be filed in public to reach us. The issue tracker
 * stays as the public option for anything that is fine in the open.
 *
 * Both stores also want a reachable publisher contact (Chrome Web Store
 * "Privacy practices", VS Code Marketplace publisher record), and they want the
 * same one that appears on the hosted policy — so there is one source for it.
 */
export const CONTACT_EMAIL = "sales@hallowsgroup.com";
export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}`;

/** Registered postal address, for written notices and data-subject requests. */
export const POSTAL_ADDRESS_LINES = [
  ENTITY,
  "5900 Balcones Drive #31966",
  "Austin, TX 78731",
  "United States",
] as const;
