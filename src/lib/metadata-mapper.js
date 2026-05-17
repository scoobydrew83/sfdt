import path from 'path';

/**
 * Map a file path to a Salesforce metadata type name.
 * Mirrors the logic in scripts/lib/metadata-parser.sh but in JS so it is
 * directly testable and reusable from commands that don't want to shell out.
 *
 * @param {string} filePath - Path to a metadata source file (relative is fine)
 * @returns {string} One of: metadata type name, 'SKIP', 'UNKNOWN'
 */
export function getMetadataType(filePath) {
  if (!filePath || typeof filePath !== 'string') return 'UNKNOWN';

  // Skip test files inside LWC/Aura bundles (e.g., __tests__/*.test.js)
  if (filePath.includes('/__tests__/')) return 'SKIP';

  // Bundled components are identified by their parent folder
  if (/\/lwc\//.test(filePath)) return 'LightningComponentBundle';
  if (/\/aura\//.test(filePath)) return 'AuraDefinitionBundle';

  const filename = path.basename(filePath);

  if (filename.endsWith('.cls') || filename.endsWith('.cls-meta.xml')) return 'ApexClass';
  if (filename.endsWith('.trigger') || filename.endsWith('.trigger-meta.xml')) return 'ApexTrigger';
  if (filename.endsWith('.flow-meta.xml')) return 'Flow';
  if (filename.endsWith('.object-meta.xml')) return 'CustomObject';
  if (filename.endsWith('.field-meta.xml')) return 'CustomField';
  if (filename.endsWith('.permissionset-meta.xml')) return 'PermissionSet';
  if (filename.endsWith('.layout-meta.xml')) return 'Layout';
  if (filename.endsWith('.page-meta.xml')) return 'ApexPage';
  if (filename.endsWith('.component-meta.xml')) return 'ApexComponent';
  if (filename.endsWith('.email-meta.xml')) return 'EmailTemplate';
  if (filename.endsWith('.app-meta.xml')) return 'CustomApplication';
  if (filename.endsWith('.tab-meta.xml')) return 'CustomTab';
  if (filename.endsWith('.labels-meta.xml')) return 'CustomLabels';
  if (filename.endsWith('.lwc-meta.xml')) return 'LightningComponentBundle';
  if (filename.endsWith('.customMetadata-meta.xml') || filename.endsWith('.md-meta.xml'))
    return 'CustomMetadata';
  if (filename.endsWith('.externalServiceRegistration-meta.xml'))
    return 'ExternalServiceRegistration';
  if (filename.endsWith('.validationRule-meta.xml')) return 'ValidationRule';
  if (filename.endsWith('.recordType-meta.xml')) return 'RecordType';
  if (filename.endsWith('.workflow-meta.xml')) return 'Workflow';
  if (filename.endsWith('.quickAction-meta.xml')) return 'QuickAction';
  if (filename.endsWith('.globalValueSet-meta.xml')) return 'GlobalValueSet';
  if (filename.endsWith('.staticresource-meta.xml')) return 'StaticResource';
  if (filename.endsWith('.profile-meta.xml')) return 'Profile';
  if (filename.endsWith('.role-meta.xml')) return 'Role';
  if (filename.endsWith('.group-meta.xml')) return 'Group';
  if (filename.endsWith('.queue-meta.xml')) return 'Queue';
  if (filename.endsWith('.flexipage-meta.xml')) return 'FlexiPage';

  return 'UNKNOWN';
}

/**
 * Derive the Metadata API member name for a given file + type pair.
 * Handles special cases: CustomField (Object.Field__c) and bundled
 * components (LWC/Aura) which are keyed by their folder name.
 */
export function getMemberName(filePath, metadataType) {
  if (metadataType === 'CustomField') {
    // Path like: objects/Account/fields/Custom__c.field-meta.xml → Account.Custom__c
    const objectMatch = filePath.match(/objects\/([^/]+)\//);
    const objectName = objectMatch ? objectMatch[1] : '';
    const fieldName = path.basename(filePath).replace(/\.field-meta\.xml$/, '');
    return objectName ? `${objectName}.${fieldName}` : fieldName;
  }

  if (metadataType === 'LightningComponentBundle' || metadataType === 'AuraDefinitionBundle') {
    return path.basename(path.dirname(filePath));
  }

  // Standard case: strip metadata suffixes
  return path
    .basename(filePath)
    .replace(
      /\.(cls-meta\.xml|cls|trigger-meta\.xml|trigger|flow-meta\.xml|object-meta\.xml|field-meta\.xml|permissionset-meta\.xml|layout-meta\.xml|page-meta\.xml|component-meta\.xml|email-meta\.xml|app-meta\.xml|tab-meta\.xml|labels-meta\.xml|lwc-meta\.xml|customMetadata-meta\.xml|md-meta\.xml|externalServiceRegistration-meta\.xml|validationRule-meta\.xml|recordType-meta\.xml|workflow-meta\.xml|quickAction-meta\.xml|globalValueSet-meta\.xml|staticresource-meta\.xml|profile-meta\.xml|role-meta\.xml|group-meta\.xml|queue-meta\.xml|flexipage-meta\.xml)$/,
      '',
    );
}

/**
 * Convert a raw `git diff --name-status` output string into structured
 * additive and destructive metadata maps.
 *
 * @param {string} diffOutput - stdout from `git diff --name-status <from> <to>`
 * @param {object} [options]
 * @param {string} [options.sourcePath] - Restrict to files under this path
 * @returns {{
 *   additive: Record<string, string[]>,
 *   destructive: Record<string, string[]>,
 *   unknown: string[],
 * }}
 */
export function parseDiffToMetadata(diffOutput, { sourcePath } = {}) {
  const additive = {};
  const destructive = {};
  const unknown = [];

  if (!diffOutput) return { additive, destructive, unknown };

  const lines = diffOutput.split('\n').filter(Boolean);

  for (const line of lines) {
    // git diff --name-status prints: STATUS<TAB>PATH  (renames: R100<TAB>OLD<TAB>NEW)
    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const status = parts[0];
    const filePath = parts[parts.length - 1]; // handles rename "R100\told\tnew"

    if (sourcePath && !filePath.includes(sourcePath) && !filePath.includes('force-app/')) {
      continue;
    }

    const type = getMetadataType(filePath);
    if (type === 'SKIP') continue;
    if (type === 'UNKNOWN') {
      unknown.push(filePath);
      continue;
    }

    const member = getMemberName(filePath, type);
    const bucket = status.startsWith('D') ? destructive : additive;

    if (!bucket[type]) bucket[type] = new Set();
    bucket[type].add(member);
  }

  // Convert Sets → sorted arrays for stable output
  return {
    additive: sortBuckets(additive),
    destructive: sortBuckets(destructive),
    unknown,
  };
}

function sortBuckets(map) {
  const out = {};
  for (const [type, members] of Object.entries(map)) {
    out[type] = [...members].sort();
  }
  return out;
}

/**
 * Render a metadata map into package.xml format.
 *
 * @param {Record<string, string[]>} metadata - Map of type → members[]
 * @param {string} apiVersion - e.g. "63.0"
 * @returns {string} package.xml content
 */
export function renderPackageXml(metadata, apiVersion = '63.0') {
  const types = Object.keys(metadata).sort();
  const body = types
    .map((type) => {
      const members = [...metadata[type]].sort();
      const memberLines = members.map((m) => `        <members>${m}</members>`).join('\n');
      return `    <types>\n${memberLines}\n        <name>${type}</name>\n    </types>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
${body}
    <version>${apiVersion}</version>
</Package>
`;
}

/**
 * Count total members across all types in a metadata map.
 */
export function countMembers(metadata) {
  return Object.values(metadata).reduce((sum, members) => sum + members.length, 0);
}
