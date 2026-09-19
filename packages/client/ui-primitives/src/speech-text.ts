/**
 * Markdown-to-speech sanitizer: turns code and Markdown into text that reads
 * naturally aloud. Used before any speech synthesis when the Accessibility
 * "strip Markdown" preference is on. A dependency-free leaf (like
 * clipboard.ts), so any client package may import it without bundle-purity
 * edges.
 */

/**
 * Strip Markdown/code syntax from text so a speech synthesizer reads words
 * instead of punctuation. Operators become Russian words.
 * @param text - raw Markdown or code text.
 * @returns plain speakable text (possibly empty).
 */
export function stripMarkdownForSpeech(text: string): string {
  if (text === '') return ''
  let out = text
  // Fenced code blocks: drop the fences, keep the code.
  out = out.replace(/```[\w-]*\n?/g, '')
  // Inline code: keep the content.
  out = out.replace(/`([^`]+)`/g, '$1')
  // ATX headers: keep the heading text.
  out = out.replace(/^#+\s+/gm, '')
  // Bold/italic: keep the words.
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1')
  out = out.replace(/\*([^*]+)\*/g, '$1')
  out = out.replace(/__([^_]+)__/g, '$1')
  out = out.replace(/_([^_]+)_/g, '$1')
  // Links: keep the visible text.
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  // HTML tags and comments.
  out = out.replace(/<!--([\s\S]*?)-->/g, 'комментарий: $1 конец комментария ')
  out = out.replace(/<[^>]*>/g, '')
  // Operators as words (longest first so === wins over ==).
  out = out
    .replace(/===/g, ' строго равно ')
    .replace(/!==/g, ' не строго равно ')
    .replace(/==/g, ' равно ')
    .replace(/!=/g, ' не равно ')
    .replace(/=>/g, ' стрелка ')
    .replace(/&&/g, ' и ')
    .replace(/\|\|/g, ' или ')
    .replace(/=/g, ' равно ')
  // Collapse blank lines, runs of spaces from word substitution, and trim.
  out = out.replace(/\n\s*\n/g, '\n\n').replace(/ {2,}/g, ' ').trim()
  return out
}

/**
 * Describe code lines for speech according to the reading mode.
 * @param lines - code lines.
 * @param mode - 'brief' announces counts, 'line' reads every line, 'full' reads everything at once.
 * @returns the speakable text.
 */
export function describeCodeForSpeech(
  lines: readonly string[],
  mode: 'brief' | 'line' | 'full',
): string {
  if (lines.length === 0) return ''
  if (mode === 'brief') return `Код, строк: ${lines.length}`
  const cleaned = lines.map(line => stripMarkdownForSpeech(line))
  if (mode === 'full') return cleaned.join('\n')
  return cleaned.map((line, index) => `Строка ${index + 1}: ${line}`).join('\n')
}
