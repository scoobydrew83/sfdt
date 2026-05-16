import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('fs-extra', () => ({
  default: {
    readFile: vi.fn(),
  },
}));
vi.mock('execa', () => ({
  execa: vi.fn(),
}));
vi.mock('glob', () => ({
  glob: vi.fn(),
}));
import {
  removeComponentFromXml,
  addComponentToXml,
  findFileForMember,
} from '../../src/lib/gui-server/handlers.js';
beforeEach(() => vi.clearAllMocks());
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>MyClass</members>
        <members>OtherClass</members>
        <name>ApexClass</name>
    </types>
    <types>
        <members>MyTrigger</members>
        <name>ApexTrigger</name>
    </types>
    <version>59.0</version>
</Package>`;
describe('removeComponentFromXml', () => {
  it('removes a member from the correct type block', () => {
    const result = removeComponentFromXml(SAMPLE_XML, 'ApexClass', 'MyClass');
    expect(result).not.toContain('<members>MyClass</members>');
    expect(result).toContain('<members>OtherClass</members>');
  });
  it('leaves other type blocks untouched', () => {
    const result = removeComponentFromXml(SAMPLE_XML, 'ApexClass', 'MyClass');
    expect(result).toContain('<members>MyTrigger</members>');
    expect(result).toContain('<name>ApexTrigger</name>');
  });
  it('returns xml unchanged when type does not exist', () => {
    const result = removeComponentFromXml(SAMPLE_XML, 'CustomObject', 'Account');
    expect(result).toBe(SAMPLE_XML);
  });
  it('returns xml unchanged when member does not exist in type', () => {
    const result = removeComponentFromXml(SAMPLE_XML, 'ApexClass', 'NonExistent');
    expect(result).toContain('<members>MyClass</members>');
    expect(result).toContain('<members>OtherClass</members>');
  });
  it('handles member names with regex special characters', () => {
    const xml = `<Package><types><members>My.Class+Name</members><name>ApexClass</name></types></Package>`;
    const result = removeComponentFromXml(xml, 'ApexClass', 'My.Class+Name');
    expect(result).not.toContain('<members>My.Class+Name</members>');
  });
});
describe('addComponentToXml', () => {
  it('adds a member to an existing type block', () => {
    const result = addComponentToXml(SAMPLE_XML, 'ApexClass', 'NewClass');
    expect(result).toContain('<members>NewClass</members>');
    expect(result).toContain('<members>MyClass</members>');
  });
  it('does not duplicate an existing member', () => {
    const result = addComponentToXml(SAMPLE_XML, 'ApexClass', 'MyClass');
    const count = (result.match(/<members>MyClass<\/members>/g) ?? []).length;
    expect(count).toBe(1);
  });
  it('creates a new type block when the type does not exist', () => {
    const result = addComponentToXml(SAMPLE_XML, 'CustomObject', 'Account');
    expect(result).toContain('<name>CustomObject</name>');
    expect(result).toContain('<members>Account</members>');
  });
  it('escapes XML special characters in member names', () => {
    const result = addComponentToXml(SAMPLE_XML, 'ApexClass', 'A&B<C>');
    expect(result).toContain('<members>A&amp;B&lt;C&gt;</members>');
  });
  it('escapes XML special characters in type names for new blocks', () => {
    const result = addComponentToXml(SAMPLE_XML, 'Custom&Type', 'MyMember');
    expect(result).toContain('<name>Custom&amp;Type</name>');
  });
  it('new type block is inserted before </Package>', () => {
    const result = addComponentToXml(SAMPLE_XML, 'Flow', 'My_Flow');
    const packageClose = result.indexOf('</Package>');
    const flowBlock = result.indexOf('<name>Flow</name>');
    expect(flowBlock).toBeGreaterThan(0);
    expect(flowBlock).toBeLessThan(packageClose);
  });
});
describe('findFileForMember', () => {
  const files = [
    '/project/force-app/main/default/classes/MyClass.cls-meta.xml',
    '/project/force-app/main/default/classes/OtherClass.cls',
    '/project/force-app/main/default/triggers/MyTrigger.trigger-meta.xml',
    '/project/force-app/main/default/objects/Account/fields/MyField__c.field-meta.xml',
  ];
  it('finds a simple top-level member by name prefix', () => {
    expect(findFileForMember(files, 'MyClass')).toContain('MyClass');
  });
  it('finds a trigger by name', () => {
    expect(findFileForMember(files, 'MyTrigger')).toContain('MyTrigger');
  });
  it('returns undefined when member is not in the list', () => {
    expect(findFileForMember(files, 'MissingClass')).toBeUndefined();
  });
  it('finds a compound member (Object.Field) by last part inside parent directory', () => {
    const result = findFileForMember(files, 'Account.MyField__c');
    expect(result).toContain('MyField__c');
    expect(result).toContain('Account');
  });
  it('returns undefined when compound member last part matches but parent directory does not', () => {
    const result = findFileForMember(files, 'Contact.MyField__c');
    expect(result).toBeUndefined();
  });
  it('returns undefined for an empty file list', () => {
    expect(findFileForMember([], 'MyClass')).toBeUndefined();
  });
  it('matches a file starting with member followed by a dash', () => {
    const dashFiles = ['/project/classes/MyClass-meta.xml'];
    expect(findFileForMember(dashFiles, 'MyClass')).toBe('/project/classes/MyClass-meta.xml');
  });
});
describe('retrieveComponentXml', () => {
  let retrieveComponentXml;
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ retrieveComponentXml } = await import('../../src/lib/gui-server/handlers.js'));
  });
  it('returns null immediately when orgAlias is falsy', async () => {
    const result = await retrieveComponentXml(null, 'ApexClass', 'MyClass', '/tmp');
    expect(result).toBeNull();
  });
  it('returns null when orgAlias is an empty string', async () => {
    const result = await retrieveComponentXml('', 'ApexClass', 'MyClass', '/tmp');
    expect(result).toBeNull();
  });
  it('returns file content when sf retrieve succeeds and xml file is found', async () => {
    const { execa: execaMock } = await import('execa');
    const { glob: globMock } = await import('glob');
    const { default: fsMock } = await import('fs-extra');
    vi.mocked(execaMock).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    vi.mocked(globMock).mockResolvedValueOnce(['/tmp/dev/classes/MyClass.cls-meta.xml']);
    fsMock.readFile.mockResolvedValueOnce('<ApexClass>content</ApexClass>');
    const result = await retrieveComponentXml('dev', 'ApexClass', 'MyClass', '/tmp');
    expect(result).toBe('<ApexClass>content</ApexClass>');
  });
  it('returns null when sf retrieve finds no xml files', async () => {
    const { execa: execaMock } = await import('execa');
    const { glob: globMock } = await import('glob');
    vi.mocked(execaMock).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    vi.mocked(globMock).mockResolvedValueOnce([]);
    const result = await retrieveComponentXml('dev', 'ApexClass', 'MyClass', '/tmp');
    expect(result).toBeNull();
  });
  it('returns null when sf retrieve throws', async () => {
    const { execa: execaMock } = await import('execa');
    vi.mocked(execaMock).mockRejectedValueOnce(new Error('sf command failed'));
    const result = await retrieveComponentXml('dev', 'ApexClass', 'MyClass', '/tmp');
    expect(result).toBeNull();
  });
  it('sanitises org alias with special characters into the output dir name', async () => {
    const { execa: execaMock } = await import('execa');
    const { glob: globMock } = await import('glob');
    const { default: fsMock } = await import('fs-extra');
    vi.mocked(execaMock).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    vi.mocked(globMock).mockResolvedValueOnce(['/tmp/my_org/classes/MyClass.cls-meta.xml']);
    fsMock.readFile.mockResolvedValueOnce('<xml/>');
    const result = await retrieveComponentXml('my-org!', 'ApexClass', 'MyClass', '/tmp');
    expect(result).toBe('<xml/>');
    const callArgs = vi.mocked(execaMock).mock.calls[0][1];
    const outputDirIdx = callArgs.indexOf('--output-dir');
    expect(callArgs[outputDirIdx + 1]).not.toContain('-');
    expect(callArgs[outputDirIdx + 1]).not.toContain('!');
  });
});
describe('batchRetrieveTypeMembers', () => {
  let batchRetrieveTypeMembers;
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ batchRetrieveTypeMembers } = await import('../../src/lib/gui-server/handlers.js'));
  });
  it('returns an empty Map when orgAlias is falsy', async () => {
    const result = await batchRetrieveTypeMembers(null, 'ApexClass', ['MyClass'], '/tmp');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
  it('returns an empty Map when members array is empty', async () => {
    const result = await batchRetrieveTypeMembers('dev', 'ApexClass', [], '/tmp');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
  it('returns a Map with file content for each found member on success', async () => {
    const { execa: execaMock } = await import('execa');
    const { glob: globMock } = await import('glob');
    const { default: fsMock } = await import('fs-extra');
    vi.mocked(execaMock).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    vi.mocked(globMock).mockResolvedValueOnce([
      '/tmp/dev_ApexClass/classes/MyClass.cls-meta.xml',
      '/tmp/dev_ApexClass/classes/OtherClass.cls-meta.xml',
    ]);
    fsMock.readFile
      .mockResolvedValueOnce('<MyClass/>')
      .mockResolvedValueOnce('<OtherClass/>');
    const result = await batchRetrieveTypeMembers('dev', 'ApexClass', ['MyClass', 'OtherClass'], '/tmp');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.get('MyClass')).toBe('<MyClass/>');
    expect(result.get('OtherClass')).toBe('<OtherClass/>');
  });
  it('returns an empty Map when sf retrieve throws', async () => {
    const { execa: execaMock } = await import('execa');
    vi.mocked(execaMock).mockRejectedValueOnce(new Error('sf retrieve failed'));
    const result = await batchRetrieveTypeMembers('dev', 'ApexClass', ['MyClass'], '/tmp');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
  it('does not include members whose files are not found in glob output', async () => {
    const { execa: execaMock } = await import('execa');
    const { glob: globMock } = await import('glob');
    const { default: fsMock } = await import('fs-extra');
    vi.mocked(execaMock).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    vi.mocked(globMock).mockResolvedValueOnce(['/tmp/dev_ApexClass/classes/MyClass.cls-meta.xml']);
    fsMock.readFile.mockResolvedValueOnce('<MyClass/>');
    const result = await batchRetrieveTypeMembers('dev', 'ApexClass', ['MyClass', 'MissingClass'], '/tmp');
    expect(result.size).toBe(1);
    expect(result.has('MissingClass')).toBe(false);
  });
  it('builds correct --metadata args for each member', async () => {
    const { execa: execaMock } = await import('execa');
    const { glob: globMock } = await import('glob');
    vi.mocked(execaMock).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    vi.mocked(globMock).mockResolvedValueOnce([]);
    await batchRetrieveTypeMembers('dev', 'ApexClass', ['ClassA', 'ClassB'], '/tmp');
    const callArgs = vi.mocked(execaMock).mock.calls[0][1];
    const metaIndices = callArgs.reduce((acc, val, i) => (val === '--metadata' ? [...acc, i] : acc), []);
    expect(metaIndices).toHaveLength(2);
    expect(callArgs[metaIndices[0] + 1]).toBe('ApexClass:ClassA');
    expect(callArgs[metaIndices[1] + 1]).toBe('ApexClass:ClassB');
  });
});
describe('readLocalComponentXml', () => {
  let readLocalComponentXml;
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ readLocalComponentXml } = await import('../../src/lib/gui-server/handlers.js'));
  });
  it('returns file content when a matching xml file is found', async () => {
    const { glob: globMock } = await import('glob');
    const { default: fsMock } = await import('fs-extra');
    vi.mocked(globMock).mockResolvedValueOnce(['/project/force-app/main/default/classes/MyClass.cls-meta.xml']);
    fsMock.readFile.mockResolvedValueOnce('<ApexClass>local</ApexClass>');
    const config = { _projectRoot: '/project', defaultSourcePath: 'force-app/main/default' };
    const result = await readLocalComponentXml(config, 'ApexClass', 'MyClass');
    expect(result).toBe('<ApexClass>local</ApexClass>');
  });
  it('returns null when glob finds no matching files', async () => {
    const { glob: globMock } = await import('glob');
    vi.mocked(globMock).mockResolvedValueOnce([]);
    const config = { _projectRoot: '/project', defaultSourcePath: 'force-app/main/default' };
    const result = await readLocalComponentXml(config, 'ApexClass', 'NonExistent');
    expect(result).toBeNull();
  });
  it('returns null when glob returns files but none are xml, cls, or trigger', async () => {
    const { glob: globMock } = await import('glob');
    vi.mocked(globMock).mockResolvedValueOnce(['/project/force-app/main/default/lwc/MyComp/MyComp.js']);
    const config = { _projectRoot: '/project', defaultSourcePath: 'force-app/main/default' };
    const result = await readLocalComponentXml(config, 'LightningComponentBundle', 'MyComp');
    expect(result).toBeNull();
  });
  it('returns content for a .cls file', async () => {
    const { glob: globMock } = await import('glob');
    const { default: fsMock } = await import('fs-extra');
    vi.mocked(globMock).mockResolvedValueOnce(['/project/force-app/main/default/classes/MyClass.cls']);
    fsMock.readFile.mockResolvedValueOnce('public class MyClass {}');
    const config = { _projectRoot: '/project', defaultSourcePath: 'force-app/main/default' };
    const result = await readLocalComponentXml(config, 'ApexClass', 'MyClass');
    expect(result).toBe('public class MyClass {}');
  });
  it('returns content for a .trigger file', async () => {
    const { glob: globMock } = await import('glob');
    const { default: fsMock } = await import('fs-extra');
    vi.mocked(globMock).mockResolvedValueOnce(['/project/force-app/main/default/triggers/MyTrigger.trigger']);
    fsMock.readFile.mockResolvedValueOnce('trigger MyTrigger on Account (before insert) {}');
    const config = { _projectRoot: '/project', defaultSourcePath: 'force-app/main/default' };
    const result = await readLocalComponentXml(config, 'ApexTrigger', 'MyTrigger');
    expect(result).toBe('trigger MyTrigger on Account (before insert) {}');
  });
  it('falls back to process.cwd() when _projectRoot is absent', async () => {
    const { glob: globMock } = await import('glob');
    vi.mocked(globMock).mockResolvedValueOnce([]);
    const config = { defaultSourcePath: 'force-app/main/default' };
    const result = await readLocalComponentXml(config, 'ApexClass', 'MyClass');
    expect(result).toBeNull();
    const callOpts = vi.mocked(globMock).mock.calls[0][1];
    expect(callOpts.cwd).toContain('force-app/main/default');
  });
  it('falls back to force-app/main/default sourcePath when defaultSourcePath is absent', async () => {
    const { glob: globMock } = await import('glob');
    vi.mocked(globMock).mockResolvedValueOnce([]);
    const config = { _projectRoot: '/project' };
    const result = await readLocalComponentXml(config, 'ApexClass', 'MyClass');
    expect(result).toBeNull();
    const callOpts = vi.mocked(globMock).mock.calls[0][1];
    expect(callOpts.cwd).toContain('force-app/main/default');
  });
  it('returns null when the matched file is outside the absSource directory', async () => {
    const { glob: globMock } = await import('glob');
    vi.mocked(globMock).mockResolvedValueOnce(['/etc/passwd.xml']);
    const config = { _projectRoot: '/project', defaultSourcePath: 'force-app/main/default' };
    const result = await readLocalComponentXml(config, 'ApexClass', 'MyClass');
    expect(result).toBeNull();
  });
});
