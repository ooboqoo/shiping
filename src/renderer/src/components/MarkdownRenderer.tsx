import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import { cn } from '@/lib/utils'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github-dark.css'
// Overrides the palette above under the light app theme (see main.css `--app-*`)
import '@/assets/hljs-github-light.css'

// remark-math only knows `$` / `$$`, but many models write `\( \)` / `\[ \]`, whose
// backslashes Markdown would otherwise eat as escapes. Code (odd parts) is left alone
function normalizeMathDelimiters(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\\\[([\s\S]*?)\\\]/g, (_, tex) => `$$${tex}$$`)
            .replace(/\\\((.*?)\\\)/g, (_, tex) => `$${tex}$`)
    )
    .join('')
}

// A formula still streaming in fails to parse: show its source in the text color, not red
const katexOptions = { errorColor: 'inherit' }

const components: Components = {
  // A table wider than the panel scrolls sideways in a box of its own (base.css):
  // the scrolling panels hide horizontal overflow, which would cut it off
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- `node` must not reach the DOM
  table: ({ node, ...props }) => (
    <div className="table-scroll">
      <table {...props} />
    </div>
  )
}

// Ref https://github.com/tailwindlabs/tailwindcss-typography to fine-tune the markdown style
function MarkdownRenderer({
  children,
  compact = false
}: {
  children: string
  /** One size down on a whole-line grid, for a thinking model's reasoning (base.css) */
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'prose prose-sm prose-invert max-w-none prose-pre:p-0 prose-code:text-xs',
        compact && 'markdown-compact'
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        // KaTeX first: remark-math emits `code.language-math`, which highlight must not see
        rehypePlugins={[[rehypeKatex, katexOptions], rehypeHighlight]}
        components={components}
      >
        {normalizeMathDelimiters(children)}
      </ReactMarkdown>
    </div>
  )
}

// Parsing and highlighting the whole answer is the expensive part, so only a
// change to the text itself re-renders it
export default memo(MarkdownRenderer)
