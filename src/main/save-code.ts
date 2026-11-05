import { clipboard } from 'electron'
import { mkdir, open } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { settings } from './settings'

/**
 * Base name used when the user leaves the setting blank.
 */
const DEFAULT_BASE_NAME = 'Test'
/** Give up after this many collisions rather than scanning the folder forever */
const MAX_SEQUENCE = 9999

/**
 * Turn whatever the user typed into a usable base name.
 *
 * Path separators are stripped rather than escaped: the name is joined onto a
 * directory the user chose, so a `../` in it would write outside that folder.
 * Characters Windows forbids are replaced rather than dropped, so `a:b` stays
 * readable as `a_b` instead of becoming `ab`.
 */
export function sanitizeBaseName(raw: string): string {
  // Control characters are exactly what a pasted name can contain and a file
  // name must not, so matching them here is the point rather than a mistake
  // eslint-disable-next-line no-control-regex
  const CONTROL_CHARS = /[\u0000-\u001f]/g
  const cleaned = raw
    .replace(/[/\\]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(CONTROL_CHARS, '_')
    .replace(/^\.+/, '')
    .trim()
  // A name of only dots or separators would resolve to the folder itself
  return cleaned || DEFAULT_BASE_NAME
}

/**
 * Fenced-code-block languages (` ```java `) and the extension each is saved as.
 * C++ has several accepted spellings but one canonical extension.
 */
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  java: '.java',
  python: '.py',
  py: '.py',
  python3: '.py',
  cpp: '.cpp',
  'c++': '.cpp',
  cxx: '.cpp',
  cc: '.cpp',
  c: '.c',
  csharp: '.cs',
  cs: '.cs',
  'c#': '.cs',
  javascript: '.js',
  js: '.js',
  node: '.js',
  typescript: '.ts',
  ts: '.ts',
  go: '.go',
  golang: '.go',
  rust: '.rs',
  rs: '.rs',
  kotlin: '.kt',
  kt: '.kt',
  swift: '.swift',
  scala: '.scala',
  ruby: '.rb',
  rb: '.rb',
  php: '.php',
  perl: '.pl',
  lua: '.lua',
  dart: '.dart',
  r: '.r',
  matlab: '.m',
  objectivec: '.m',
  'objective-c': '.m',
  sql: '.sql',
  sh: '.sh',
  shell: '.sh',
  bash: '.sh',
  ps1: '.ps1',
  powershell: '.ps1',
  groovy: '.groovy',
  elixir: '.ex',
  erlang: '.erl',
  haskell: '.hs',
  clojure: '.clj',
  julia: '.jl',
  pascal: '.pas',
  delphi: '.pas',
  fortran: '.f90',
  cobol: '.cob',
  vb: '.vb',
  vbnet: '.vb',
  asm: '.asm',
  assembly: '.asm',
  solidity: '.sol',
  verilog: '.v',
  vhdl: '.vhd'
}

/** Languages that are not source code, so a sniffed language may safely win */
const NON_LANGUAGE_TAGS = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'output', 'raw'])

type CodeBlock = { language: string; code: string }

/**
 * Pull the fenced code blocks out of a Markdown answer. Only a fence whose info
 * string is a single word or `c++` counts as the start of a block, so a fence
 * written inline inside a sentence (or a nested example in prose) is ignored.
 */
function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  const lines = markdown.split('\n')

  let fenceMarker: string | null = null
  let language = ''
  let body: string[] = []

  for (const line of lines) {
    if (fenceMarker === null) {
      const opener = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*([A-Za-z0-9+#._-]*)[ \t]*$/)
      if (opener) {
        fenceMarker = opener[1][0]
        language = opener[2].toLowerCase()
        body = []
      }
      continue
    }

    // A closing fence is the same marker with nothing else on the line
    if (/^[ \t]*(`{3,}|~{3,})[ \t]*$/.test(line) && line.trim().startsWith(fenceMarker)) {
      blocks.push({ language, code: body.join('\n') })
      fenceMarker = null
      language = ''
      body = []
      continue
    }

    body.push(line)
  }

  // An unterminated fence still holds usable code
  if (fenceMarker !== null) blocks.push({ language, code: body.join('\n') })

  return blocks
}

/** Best-effort language guess for a fence the model left unlabelled */
function sniffLanguage(code: string): string {
  if (/^\s*#include\s*[<"]/.test(code) || /\busing\s+namespace\s+std\b/.test(code)) return 'cpp'
  if (/\bSystem\.out\.print/.test(code) || /\bpublic\s+(static\s+)?(class|void)\b/.test(code)) {
    return 'java'
  }
  if (/^\s*(def\s+\w+|class\s+\w+\s*(\(.*\))?\s*:)/m.test(code) || /\bprint\s*\(/.test(code)) {
    return 'python'
  }
  // Go and Rust before JavaScript: `const x =` and `=>` are valid in both too
  if (/^\s*package\s+main\b/m.test(code) || /\bfunc\s+\w+\s*\(/.test(code)) return 'go'
  if (/\bfn\s+\w+\s*\(/.test(code)) return 'rust'
  if (/\bfunction\b|\bconst\s+\w+\s*=|=>/.test(code)) return 'javascript'
  return ''
}

function resolveExtension(block: CodeBlock): string {
  const mapping = LANGUAGE_EXTENSIONS[block.language]
  if (mapping) return mapping

  if (NON_LANGUAGE_TAGS.has(block.language)) {
    // Unlabelled (or explicitly non-code): trust the code itself when it says
    // what it is, otherwise fall back to plain text rather than guessing wrong
    return LANGUAGE_EXTENSIONS[sniffLanguage(block.code)] ?? '.txt'
  }

  // Labelled with something we do not know: keep the label as the extension
  return `.${basename(block.language)}`
}

/**
 * Reserve the first free `<base><n><ext>` in `dir` and write `code` into it.
 * `open(..., 'wx')` fails if the path exists, which keeps two near-simultaneous
 * saves from picking the same name — the check and the create are one step.
 */
async function writeWithUniqueName(
  dir: string,
  baseName: string,
  extension: string,
  code: string
): Promise<string> {
  for (let sequence = 1; sequence <= MAX_SEQUENCE; sequence++) {
    const filePath = join(dir, `${baseName}${sequence}${extension}`)
    let handle
    try {
      handle = await open(filePath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      await handle.writeFile(code, 'utf8')
    } finally {
      await handle.close()
    }
    return filePath
  }
  throw new Error(`No free file name left in ${dir}`)
}

/**
 * Write to `<base><ext>`, replacing whatever was there.
 *
 * A plain `writeFile` rather than the exclusive create above: overwriting is
 * the point here, so the file is opened for truncation instead. Note that this
 * replaces any file of that name in the folder, not only ones this app wrote —
 * the mode is an explicit opt-in for exactly that reason.
 */
async function writeOverwriting(
  dir: string,
  baseName: string,
  extension: string,
  code: string
): Promise<string> {
  const filePath = join(dir, `${baseName}${extension}`)
  const handle = await open(filePath, 'w')
  try {
    await handle.writeFile(code, 'utf8')
  } finally {
    await handle.close()
  }
  return filePath
}

/**
 * Find the first code block of a finished answer, i.e. the code the user is
 * most likely to want. Returns null when the answer holds no code at all,
 * which is how non-coding answers (an English exam, an aptitude test) are
 * filtered out.
 */
function pickCodeBlock(answer: string): CodeBlock | null {
  return extractCodeBlocks(answer).find((candidate) => candidate.code.trim() !== '') ?? null
}

/**
 * Copy the answer's code block to the system clipboard, so the user can paste
 * it straight into an editor. Only the code is copied — the fence markers
 * would just be noise when pasted.
 */
export async function copyCodeToClipboard(answer: string): Promise<void> {
  if (!settings.codeCopyToClipboard) return

  const block = pickCodeBlock(answer)
  if (!block) return

  // Asynchronous since Electron 44, like navigator.clipboard
  try {
    await clipboard.writeText(block.code)
  } catch (error) {
    console.error('Failed to copy code to the clipboard:', error)
  }
}

/**
 * Save the first code block of a finished answer to the configured folder.
 *
 * Runs silently and best-effort: anything that says "this was not a coding
 * answer" (no code block), anything the user turned off, and any I/O failure
 * just ends the attempt without disturbing the user.
 */
export async function saveCodeToDisk(answer: string): Promise<void> {
  if (!settings.codeAutoSave || !settings.codeSaveDir) return

  const block = pickCodeBlock(answer)
  if (!block) return

  const dir = settings.codeSaveDir
  try {
    await mkdir(dir, { recursive: true })
    const baseName = sanitizeBaseName(settings.codeFileBaseName)
    const extension = resolveExtension(block)
    const filePath =
      settings.codeNamingMode === 'overwrite'
        ? await writeOverwriting(dir, baseName, extension, block.code)
        : await writeWithUniqueName(dir, baseName, extension, block.code)
    console.log('Saved code to', filePath)
  } catch (error) {
    console.error('Failed to save code:', error)
  }
}

/**
 * Handle the code block of a finished answer: copy it to the clipboard and/or
 * write it to the configured folder, whichever the user turned on. Both are
 * best-effort and silent.
 */
export function handleGeneratedCode(answer: string): void {
  void copyCodeToClipboard(answer)
  void saveCodeToDisk(answer)
}
