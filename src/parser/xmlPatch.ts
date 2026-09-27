export type PdmEdit = {
  element: 'o:Table' | 'o:Column';
  pdId: string;
  child: string;
  value: string | number | boolean | null;
};

interface ElementBlock {
  contentStart: number;
  contentEnd: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isNameBoundary(char: string | undefined): boolean {
  return char === undefined || char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '>' || char === '/';
}

function insideComment(xml: string, index: number): boolean {
  const open = xml.lastIndexOf('<!--', index);
  if (open === -1) return false;
  return xml.lastIndexOf('-->', index) < open;
}

function skipComment(xml: string, from: number): number {
  const end = xml.indexOf('-->', from);
  return end === -1 ? xml.length : end + 3;
}

function findClosingIndex(xml: string, tag: string, from: number): number {
  let depth = 1;
  let index = from;

  while (index < xml.length) {
    const lt = xml.indexOf('<', index);
    if (lt === -1) return -1;

    if (xml.startsWith('<!--', lt)) {
      index = skipComment(xml, lt + 4);
      continue;
    }

    if (xml.startsWith(`</${tag}`, lt) && isNameBoundary(xml[lt + 2 + tag.length])) {
      const gt = xml.indexOf('>', lt);
      if (gt === -1) return -1;
      depth -= 1;
      if (depth === 0) return lt;
      index = gt + 1;
      continue;
    }

    if (xml.startsWith(`<${tag}`, lt) && isNameBoundary(xml[lt + 1 + tag.length])) {
      const gt = xml.indexOf('>', lt);
      if (gt === -1) return -1;
      if (xml[gt - 1] !== '/') depth += 1;
      index = gt + 1;
      continue;
    }

    const gt = xml.indexOf('>', lt);
    if (gt === -1) return -1;
    index = gt + 1;
  }

  return -1;
}

function findElementBlock(xml: string, tag: string, pdId: string): ElementBlock | null {
  const idPattern = new RegExp(`(^|[\\s])Id="${escapeRegExp(pdId)}"`);
  const needle = `<${tag}`;
  let index = 0;

  while (index < xml.length) {
    const at = xml.indexOf(needle, index);
    if (at === -1) return null;

    if (!isNameBoundary(xml[at + needle.length]) || insideComment(xml, at)) {
      index = at + needle.length;
      continue;
    }

    const gt = xml.indexOf('>', at);
    if (gt === -1) return null;

    if (idPattern.test(xml.slice(at + needle.length, gt))) {
      if (xml[gt - 1] === '/') return null;
      const contentStart = gt + 1;
      const contentEnd = findClosingIndex(xml, tag, contentStart);
      if (contentEnd === -1) return null;
      return { contentStart, contentEnd };
    }

    index = gt + 1;
  }

  return null;
}

function childPattern(child: string): RegExp {
  return new RegExp(`<${escapeRegExp(child)}(\\s[^>]*)?>[\\s\\S]*?</${escapeRegExp(child)}>`);
}

function removeChild(content: string, child: string): string {
  const leadingBreak = new RegExp(`\\n?<${escapeRegExp(child)}(\\s[^>]*)?>[\\s\\S]*?</${escapeRegExp(child)}>`);
  return content.replace(leadingBreak, '');
}

function insertChild(content: string, child: string, text: string): string {
  const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  return `${content}${separator}<${child}>${text}</${child}>\n`;
}

function rewrite(xml: string, block: ElementBlock, next: string): string {
  return xml.slice(0, block.contentStart) + next + xml.slice(block.contentEnd);
}

export function applyPdmEdits(xml: string, edits: PdmEdit[]): string {
  let result = xml;

  for (const edit of edits) {
    const block = findElementBlock(result, edit.element, edit.pdId);
    if (!block) continue;

    const content = result.slice(block.contentStart, block.contentEnd);

    if (edit.value === null || edit.value === false) {
      if (!childPattern(edit.child).test(content)) continue;
      result = rewrite(result, block, removeChild(content, edit.child));
      continue;
    }

    const text = typeof edit.value === 'boolean' ? '1' : escapeXml(String(edit.value));
    const pattern = childPattern(edit.child);

    result = rewrite(
      result,
      block,
      pattern.test(content) ? content.replace(pattern, `<${edit.child}>${text}</${edit.child}>`) : insertChild(content, edit.child, text),
    );
  }

  return result;
}
