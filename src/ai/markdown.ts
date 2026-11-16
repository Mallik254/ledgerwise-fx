function escapeHtml(raw: string): string {
  return raw.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return ch;
    }
  });
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  // Inline code
  out = out.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  return out;
}

export function renderMarkdown(raw: string): string {
  if (!raw) return '';

  // Extract fenced code blocks first
  const codeBlocks: string[] = [];
  const withPlaceholders = raw.replace(/```[\w-]*\n([\s\S]*?)```/g, (_match, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="ai-code-block"><code>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `@@CODEBLOCK_${idx}@@`;
  });

  const lines = withPlaceholders.split('\n');
  const htmlParts: string[] = [];
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) {
      htmlParts.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      htmlParts.push('</ol>');
      inOl = false;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const cbMatch = /^@@CODEBLOCK_(\d+)@@$/.exec(trimmed);
    if (cbMatch) {
      closeLists();
      htmlParts.push(codeBlocks[Number(cbMatch[1])] ?? '');
      continue;
    }

    if (!trimmed) {
      closeLists();
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      closeLists();
      const level = Math.min(4, Math.max(2, headingMatch[1].length + 1));
      htmlParts.push(`<h${level} class="ai-md-h">${renderInline(headingMatch[2])}</h${level}>`);
      continue;
    }

    const ulMatch = /^[-*•]\s+(.+)$/.exec(trimmed);
    if (ulMatch) {
      if (inOl) {
        htmlParts.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        htmlParts.push('<ul class="ai-md-list">');
        inUl = true;
      }
      htmlParts.push(`<li>${renderInline(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (olMatch) {
      if (inUl) {
        htmlParts.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        htmlParts.push('<ol class="ai-md-list ordered">');
        inOl = true;
      }
      htmlParts.push(`<li>${renderInline(olMatch[1])}</li>`);
      continue;
    }

    closeLists();
    htmlParts.push(`<p class="ai-md-p">${renderInline(trimmed)}</p>`);
  }

  closeLists();
  return htmlParts.join('');
}
