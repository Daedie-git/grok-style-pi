// Just enough of Bash's lexer to find which commands a Bash tool call runs: quotes, escapes, comments, line
// continuations, command substitutions (nested scripts) and here-documents (data, except an unquoted one's
// substitutions). Expansions otherwise stay literal. It steers a model away from mistakes, not an adversary: a
// here-document inside $(...) whose body holds a ")" ends the substitution early, refusing inert text.

export type Lexed = { commands: string[][]; scripts: string[] }

// Skips a quoted span starting at its opening quote; returns the index of the closing quote.
function skipQuoted(text: string, i: number): number {
  if (text[i] === "'") {
    const end = text.indexOf("'", i + 1)
    return end < 0 ? text.length : end
  }
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++
    else if (text[j] === '"') return j
    else if (text.startsWith('$(', j)) j = readSubstitution(text, j + 2)[1]
    else if (text[j] === '`') j = readBackticks(text, j + 1)[1]
  }
  return text.length
}

// The body of `$(` ... `)` starting just past `$(`, and the index of its closing parenthesis.
function readSubstitution(text: string, i: number): [string, number] {
  let depth = 1
  for (let j = i; j < text.length; j++) {
    const c = text[j]
    if (c === '\\') j++
    else if (c === "'" || c === '"') j = skipQuoted(text, j)
    // A comment runs to the end of its line, quotes and parentheses included.
    else if (c === '#' && (j === i || /[\s;&|()]/.test(text[j - 1]!))) {
      while (j + 1 < text.length && text[j + 1] !== '\n') j++
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return [text.slice(i, j), j]
  }
  return [text.slice(i), text.length]
}

// The script a backtick substitution runs, starting just past its opening backtick, and the closing backtick's index.
// Bash drops the backslash before $, ` and \\ inside backticks before running the body.
function readBackticks(text: string, i: number): [string, number] {
  const decode = (body: string) => body.replace(/\\([$`\\])/g, '$1')
  for (let j = i; j < text.length; j++) {
    if (text[j] === '\\') j++
    else if (text[j] === '`') return [decode(text.slice(i, j)), j]
  }
  return [decode(text.slice(i)), text.length]
}

// The substitutions in text where only expansions are live: double-quoted text and unquoted here-document bodies.
function expansions(text: string, scripts: string[]) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text.startsWith('$(', i)) {
      const [body, end] = readSubstitution(text, i + 2)
      scripts.push(body)
      i = end
    } else if (text[i] === '`') {
      const [body, end] = readBackticks(text, i + 1)
      scripts.push(body)
      i = end
    }
  }
}

// The simple commands of a script as words, split at ; & | ( ) and newlines, and the scripts its substitutions run.
export function lex(script: string): Lexed {
  const commands: string[][] = []
  const scripts: string[] = []
  const heredocs: { delimiter: string; quoted: boolean; dash: boolean }[] = []
  let words: string[] = []
  let word: string | undefined
  const add = (text: string) => (word = (word ?? '') + text)
  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  // Consumes the pending here-document bodies after the newline at i; returns the index of the last consumed char.
  const readHeredocs = (i: number) => {
    let pos = i + 1
    for (const { delimiter, quoted, dash } of heredocs) {
      let body = ''
      while (pos < script.length) {
        const end = script.indexOf('\n', pos)
        const line = script.slice(pos, end < 0 ? undefined : end)
        pos = end < 0 ? script.length : end + 1
        if ((dash ? line.replace(/^\t+/, '') : line) === delimiter) break
        body += `${line}\n`
      }
      if (!quoted) expansions(body, scripts)
    }
    heredocs.length = 0
    return pos - 1
  }
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!
    if (c === '\\') {
      if (script[i + 1] !== '\n') add(script[i + 1] ?? '')
      i++
    } else if (c === "'") {
      const end = skipQuoted(script, i)
      add(script.slice(i + 1, end))
      i = end
    } else if (c === '"') {
      const end = skipQuoted(script, i)
      const inner = script.slice(i + 1, end)
      expansions(inner, scripts)
      add(inner.replace(/\\(["\\$`\n])/g, (_, x: string) => (x === '\n' ? '' : x)))
      i = end
    } else if (script.startsWith('$(', i)) {
      const [body, end] = readSubstitution(script, i + 2)
      scripts.push(body)
      add(`$(${body})`)
      i = end
    } else if (c === '`') {
      const [body, end] = readBackticks(script, i + 1)
      scripts.push(body)
      add(`\`${body}\``)
      i = end
    } else if (script.startsWith('<<', i) && script[i + 2] !== '<' && !word?.endsWith('<')) {
      // A here-document: its delimiter may be quoted, which makes the body plain data.
      let j = i + 2
      const dash = script[j] === '-'
      if (dash) j++
      while (script[j] === ' ' || script[j] === '\t') j++
      let delimiter = ''
      let quoted = false
      for (; j < script.length && !/[\s;&|()<>]/.test(script[j]!); j++) {
        const q = script[j]!
        if (q === "'" || q === '"') {
          const end = skipQuoted(script, j)
          delimiter += script.slice(j + 1, end)
          quoted = true
          j = end
        } else if (q === '\\') {
          delimiter += script[++j] ?? ''
          quoted = true
        } else delimiter += q
      }
      // A file descriptor written against the operator (0<<EOF) belongs to it.
      const fd = word !== undefined && /^\d+$/.test(word) ? word : ''
      if (fd) word = undefined
      endWord()
      words.push(`${fd}<<${delimiter}`)
      if (delimiter) heredocs.push({ delimiter, quoted, dash })
      i = j - 1
    } else if (c === '&' && word !== undefined && /[<>]$/.test(word)) add(c)
    else if (c === '\n') {
      endCommand()
      if (heredocs.length) i = readHeredocs(i)
    } else if (/[;&|()]/.test(c)) endCommand()
    else if (/\s/.test(c)) endWord()
    else if (c === '#' && word === undefined) {
      while (i + 1 < script.length && script[i + 1] !== '\n') i++
    } else add(c)
  }
  endCommand()
  return { commands, scripts }
}
