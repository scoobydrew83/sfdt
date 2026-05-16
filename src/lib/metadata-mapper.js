import path from 'path';
export function getMetadataType(filePath) {
  if (!filePath || typeof filePath !== 'string') return 'UNKNOWN';
export function getMemberName(filePath, metadataType) {
  if (metadataType === 'CustomField') {
    const objectMatch = filePath.match(/objects\/([^/]+)\
    const objectName = objectMatch ? objectMatch[1] : '';
    const fieldName = path.basename(filePath).replace(/\.field-meta\.xml$/, '');
    return objectName ? `${objectName}.${fieldName}` : fieldName;
  }
  if (metadataType === 'LightningComponentBundle' || metadataType === 'AuraDefinitionBundle') {
    return path.basename(path.dirname(filePath));
  }
  return path
    .basename(filePath)
    .replace(
      /\.(cls-meta\.xml|cls|trigger-meta\.xml|trigger|flow-meta\.xml|object-meta\.xml|field-meta\.xml|permissionset-meta\.xml|layout-meta\.xml|page-meta\.xml|component-meta\.xml|email-meta\.xml|app-meta\.xml|tab-meta\.xml|labels-meta\.xml|lwc-meta\.xml|customMetadata-meta\.xml|md-meta\.xml|externalServiceRegistration-meta\.xml|validationRule-meta\.xml|recordType-meta\.xml|workflow-meta\.xml|quickAction-meta\.xml|globalValueSet-meta\.xml|staticresource-meta\.xml|profile-meta\.xml|role-meta\.xml|group-meta\.xml|queue-meta\.xml|flexipage-meta\.xml)$/,
      '',
    );
}
export function parseDiffToMetadata(diffOutput, { sourcePath } = {}) {
  const additive = {};
  const destructive = {};
  const unknown = [];
  if (!diffOutput) return { additive, destructive, unknown };
  const lines = diffOutput.split('\n').filter(Boolean);
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const status = parts[0];
    const filePath = parts[parts.length - 1];
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
export function countMembers(metadata) {
  return Object.values(metadata).reduce((sum, members) => sum + members.length, 0);
}
