/**
 * Registers every ledger reverser.
 *
 * `ledger undo` can be run standalone, long after — and in a different process
 * from — the command that made the change. Nothing else would have imported the
 * module that knows how to reverse it, so the registry would be empty and every
 * undo would report "no reverser registered" for a kind that plainly has one.
 *
 * So this module is the single place that knows the full set, and
 * `sfdt ledger undo` calls it before looking anything up. Each runner registers
 * its own reversers as an import side effect — the knowledge of HOW to reverse a
 * change stays with the code that made it, and only the list lives here.
 *
 * Adding a new writing feature means adding one line below. A reverser that is
 * never registered is not a silent failure: `undoChange` reports the kind as not
 * automatically reversible and prints the before-state, so the change can still
 * be undone by hand.
 */
export async function registerAllReversers() {
  await Promise.all([
    import('./automation-runner.js'),
    import('./permissions-write-runner.js'),
  ]);
}
