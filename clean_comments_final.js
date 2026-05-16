import fs from 'fs';
import path from 'path';
import ts from 'typescript';
const files = [
  'extension/ui/health-modal.ts',
  'extension/ui/toast.ts',
  'extension/ui/side-button.ts',
  'extension/entrypoints/options/index.html',
  'extension/entrypoints/options/main.ts',
  'extension/entrypoints/content.ts',
  'extension/entrypoints/background.ts'
];
function cleanTsComments(content) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false);
  scanner.setText(content);
  let result = '';
  let lastPos = 0;
  const comments = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push({
        start: scanner.getTokenPos(),
        end: scanner.getTextPos(),
        type: token
      });
    }
    token = scanner.scan();
  }
  let lines = content.split('\n');
  let newContent = content;
  comments.sort((a, b) => b.start - a.start);
  for (const comment of comments) {
    const start = comment.start;
    const end = comment.end;
    const before = content.substring(0, start);
    const after = content.substring(end);
    const lastNewlineBefore = before.lastIndexOf('\n');
    const firstNewlineAfter = after.indexOf('\n');
    const lineStart = lastNewlineBefore === -1 ? 0 : lastNewlineBefore + 1;
    const lineEnd = firstNewlineAfter === -1 ? content.length : end + firstNewlineAfter;
    const textBeforeOnLine = content.substring(lineStart, start);
    const textAfterOnLine = firstNewlineAfter === -1 ? "" : after.substring(0, firstNewlineAfter);
    if (textBeforeOnLine.trim() === '' && textAfterOnLine.trim() === '') {
      let removalStart = lineStart;
      let removalEnd = firstNewlineAfter === -1 ? content.length : end + firstNewlineAfter + 1;
      newContent = newContent.substring(0, removalStart) + newContent.substring(removalEnd);
    } else {
      const spaceMatch = textBeforeOnLine.match(/\s+$/);
      const spaceLen = spaceMatch ? spaceMatch[0].length : 0;
      newContent = newContent.substring(0, start - spaceLen) + newContent.substring(end);
    }
  }
  return newContent;
}
function cleanHtmlComments(content) {
  return content.replace(/[\t ]*<!--[\s\S]*?-->\n?/g, (match) => {
    if (match.endsWith('\n')) return '';
    return '';
  });
}
for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`Skipping missing file: ${file}`);
    continue;
  }
  const content = fs.readFileSync(file, 'utf8');
  let cleaned;
  if (file.endsWith('.ts')) {
    cleaned = cleanTsComments(content);
  } else if (file.endsWith('.html')) {
    cleaned = cleanHtmlComments(content);
  }
  fs.writeFileSync(file, cleaned);
  console.log(`Modified: ${file}`);
}
