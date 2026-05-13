import fs from 'fs-extra';
import path from 'path';
import { execa } from 'execa';

export function removeComponentFromXml(xml, type, member) {
  const blockPattern = /(<types>[\s\S]*?<\/types>)/g;
  return xml.replace(blockPattern, (block) => {
    const nameMatch = block.match(/<name>([^<]+)<\/name>/);
    if (!nameMatch || nameMatch[1].trim() !== type) return block;
    return block.replace(new RegExp(`\\s*<members>${member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/members>`, 'g'), '');
  });
}

export function addComponentToXml(xml, type, member) {
  const escapedType = type.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escaped = member.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blockPattern = /(<types>[\s\S]*?<\/types>)/g;
  let inserted = false;
  let result = xml.replace(blockPattern, (block) => {
    const nameMatch = block.match(/<name>([^<]+)<\/name>/);
    if (!nameMatch || nameMatch[1].trim() !== type) return block;
    if (block.includes(`<members>${escaped}</members>`)) { inserted = true; return block; }
    const updated = block.replace(/(<name>[^<]+<\/name>)/, `<members>${escaped}</members>\n    $1`);
    inserted = true;
    return updated;
  });
  if (!inserted) {
    const newBlock = `    <types>\n        <members>${escaped}</members>\n        <name>${escapedType}</name>\n    </types>\n`;
    result = result.replace(/<\/Package>/, `${newBlock}</Package>`);
  }
  return result;
}

export async function retrieveComponentXml(orgAlias, type, member, tmpDir) {
  if (!orgAlias) return null;
  const outputDir = path.join(tmpDir, orgAlias.replace(/[^a-z0-9]/gi, '_'));
  try {
    await execa('sf', [
      'project',
      'retrieve',
      'start',
      '--metadata',
      `${type}:${member}`,
      '--target-org',
      orgAlias,
      '--output-dir',
      outputDir,
      '--json',
    ]);
    const { glob } = await import('glob');
    const files = await glob('**/*.xml', { cwd: outputDir, absolute: true });
    if (!files.length) return null;
    return fs.readFile(files[0], 'utf8');
  } catch {
    return null;
  }
}

export function findFileForMember(files, member) {
  const parts = member.split('.');
  const lastName = parts[parts.length - 1];
  return files.find((f) => {
    const base = path.basename(f);
    if (base.startsWith(member + '.') || base.startsWith(member + '-')) return true;
    if (parts.length > 1) {
      const dir = path.dirname(f);
      return (base.startsWith(lastName + '.') || base.startsWith(lastName + '-')) &&
        dir.includes(parts[0]);
    }
    return false;
  });
}

export async function batchRetrieveTypeMembers(orgAlias, type, members, tmpDir) {
  if (!orgAlias || !members.length) return new Map();
  const outputDir = path.join(
    tmpDir,
    `${orgAlias.replace(/[^a-z0-9]/gi, '_')}_${type.replace(/[^a-z0-9]/gi, '_')}`
  );
  const metadataArgs = members.flatMap((m) => ['--metadata', `${type}:${m}`]);
  try {
    await execa('sf', [
      'project', 'retrieve', 'start',
      ...metadataArgs,
      '--target-org', orgAlias,
      '--output-dir', outputDir,
      '--json',
    ]);
    const { glob } = await import('glob');
    const files = await glob('**/*.xml', { cwd: outputDir, absolute: true });
    const result = new Map();
    for (const member of members) {
      const file = findFileForMember(files, member);
      if (file) result.set(member, await fs.readFile(file, 'utf8'));
    }
    return result;
  } catch {
    return new Map();
  }
}

export async function readLocalComponentXml(config, _type, member) {
  const { glob } = await import('glob');
  const fsExtra = (await import('fs-extra')).default;
  const sourcePath = config.defaultSourcePath ?? 'force-app/main/default';
  const root = config._projectRoot ?? process.cwd();
  const absSource = path.join(root, sourcePath);
  const safeMember = member.replace(/[[\]{}()*+?\\^$|]/g, '\\$&');
  const files = await glob(`**/${safeMember}*`, {
    cwd: absSource,
    absolute: true,
    nodir: true,
  });
  const xmlFile = files.find(
    (f) =>
      !path.relative(absSource, f).startsWith('..') &&
      (f.endsWith('.xml') || f.endsWith('.cls') || f.endsWith('.trigger'))
  );
  if (!xmlFile) return null;
  return fsExtra.readFile(xmlFile, 'utf8');
}
