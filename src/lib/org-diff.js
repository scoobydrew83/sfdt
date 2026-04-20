/**
 * Diff two metadata inventories and produce a structured result.
 *
 * @param {Map<string, Set<string>>} sourceMap
 * @param {Map<string, Set<string>>} targetMap
 * @returns {Array<{ type: string, member: string, status: 'source-only'|'target-only'|'both' }>}
 */
export function diffInventories(sourceMap, targetMap) {
  const result = [];
  const allTypes = new Set([...sourceMap.keys(), ...targetMap.keys()]);

  for (const type of allTypes) {
    const sourceMembers = sourceMap.get(type) ?? new Set();
    const targetMembers = targetMap.get(type) ?? new Set();

    for (const member of sourceMembers) {
      result.push({
        type,
        member,
        status: targetMembers.has(member) ? 'both' : 'source-only',
      });
    }

    for (const member of targetMembers) {
      if (!sourceMembers.has(member)) {
        result.push({ type, member, status: 'target-only' });
      }
    }
  }

  return result.sort((a, b) => {
    const keyA = `${a.type}.${a.member}`;
    const keyB = `${b.type}.${b.member}`;
    return keyA.localeCompare(keyB);
  });
}
