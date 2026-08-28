import { describe, expect, it } from 'vitest'
import {
  escapeAttribute,
  escapeHtml,
  escapeJsonLd,
  guardPayloadSize,
  isValidSlug,
  LIMITS,
  sanitizeComment,
  sanitizeDescription,
  sanitizeFilename,
  sanitizeTag,
  sanitizeTags,
  sanitizeTitle,
  sanitizeUrl,
  slugStem,
} from './sanitize'

/**
 * Hostile input, by category.
 *
 * Each block is a class of attack rather than a list of strings somebody once
 * saw: markup injection, invisible-character spoofing, path traversal, scheme
 * smuggling and resource exhaustion. A payload that is only in a list gets
 * fixed once; a property gets fixed for good.
 */

describe('text sanitisation', () => {
  it('removes every markup delimiter rather than escaping it', () => {
    for (const payload of [
      '<script>alert(1)</script>',
      '"><img src=x onerror=alert(1)>',
      '</title></head><body>',
      '&lt;script&gt;',
      '&#60;script&#62;',
      '<<SCRIPT>alert("XSS");//<</SCRIPT>',
    ]) {
      const cleaned = sanitizeTitle(payload)
      expect(cleaned).not.toContain('<')
      expect(cleaned).not.toContain('>')
      expect(cleaned).not.toContain('&')
    }
  })

  it('strips control codes, zero-width characters and bidi overrides', () => {
    const trojan = `Safe\u202eModel\u202c\u200b\u200f\ufeff\u0000\u0007`
    const cleaned = sanitizeTitle(trojan)
    for (const code of [0x202e, 0x202c, 0x200b, 0x200f, 0xfeff, 0x0000, 0x0007]) {
      expect(cleaned.includes(String.fromCodePoint(code)), `U+${code.toString(16)} survived`).toBe(false)
    }
    expect(cleaned).toBe('Safe Model')
  })

  it('strips the line separators that break an inline script', () => {
    expect(sanitizeTitle('a\u2028b\u2029c')).toBe('a b c')
  })

  it('collapses exotic whitespace so a title cannot be padded off-screen', () => {
    expect(sanitizeTitle('a\u00a0\u2003\u3000b')).toBe('a b')
    expect(sanitizeTitle('   spaced   out   ')).toBe('spaced out')
  })

  it('normalises to NFC so two spellings of one title compare equal', () => {
    expect(sanitizeTitle('e\u0301clair')).toBe(sanitizeTitle('\u00e9clair'))
  })

  it('caps length in code points, not UTF-16 units', () => {
    expect([...sanitizeTitle('x'.repeat(500))]).toHaveLength(LIMITS.title)
    // Emoji are surrogate pairs; a UTF-16 cap would halve the allowance and
    // could cut one in two.
    const emoji = sanitizeTitle('\u{1f9f1}'.repeat(300))
    expect([...emoji].length).toBeLessThanOrEqual(LIMITS.title)
    expect(emoji).not.toContain('\ufffd')
  })

  it('refuses to spend unbounded time on a huge input', () => {
    const started = Date.now()
    expect(sanitizeTitle('\u0301'.repeat(5_000_000)).length).toBeLessThanOrEqual(LIMITS.title)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('returns an empty string for anything that is not a string', () => {
    for (const value of [null, undefined, 42, {}, [], true, Symbol('x')]) {
      expect(sanitizeTitle(value)).toBe('')
    }
  })

  it('keeps paragraphs in a description but collapses layout abuse', () => {
    expect(sanitizeDescription('one\n\n\n\n\n\ntwo')).toBe('one\n\ntwo')
    expect(sanitizeDescription('one\r\ntwo')).toBe('one\ntwo')
    expect(sanitizeComment('  hello  \n  world  ')).toBe('hello\nworld')
    expect([...sanitizeComment('x'.repeat(9999))]).toHaveLength(LIMITS.comment)
  })
})

describe('tags', () => {
  it('reduces a tag to one lowercase word', () => {
    expect(sanitizeTag('Space Ship')).toBe('space-ship')
    expect(sanitizeTag('  --Technic--  ')).toBe('technic')
    expect(sanitizeTag('<b>bold</b>')).toBe('b-bold-b')
    expect(sanitizeTag('!!!')).toBe('')
  })

  it('deduplicates, sorts and caps the tag list', () => {
    expect(sanitizeTags(['B', 'a', 'a', 'A', ''])).toEqual(['a', 'b'])
    expect(sanitizeTags(Array.from({ length: 40 }, (_, index) => `tag${index}`))).toHaveLength(LIMITS.tags)
    expect(sanitizeTags('not an array')).toEqual([])
  })
})

describe('filenames', () => {
  it('cannot escape a directory', () => {
    for (const payload of [
      '../../etc/passwd',
      '....//....//etc/passwd',
      '..\\..\\windows\\system32\\config',
      '/absolute/path.ldr',
      'C:\\Users\\me\\model.ldr',
      'a/b/c/../../../../../../etc/shadow',
    ]) {
      const cleaned = sanitizeFilename(payload)
      expect(cleaned).not.toContain('/')
      expect(cleaned).not.toContain('\\')
      expect(cleaned).not.toContain('..')
      expect(cleaned.startsWith('.')).toBe(false)
    }
  })

  it('drops control codes and NUL-byte extension tricks', () => {
    expect(sanitizeFilename('model\u0000.png.ldr')).toBe('model.png.ldr')
    expect(sanitizeFilename('model\n\r\t.ldr')).toBe('model.ldr')
  })

  it('renames a Windows device name rather than emitting one', () => {
    expect(sanitizeFilename('CON')).toBe('file-CON')
    expect(sanitizeFilename('lpt1.txt')).toBe('file-lpt1.txt')
    expect(sanitizeFilename('console.txt')).toBe('console.txt')
  })

  it('falls back rather than returning nothing', () => {
    expect(sanitizeFilename('...')).toBe('model')
    expect(sanitizeFilename('')).toBe('model')
    expect(sanitizeFilename(null, 'export')).toBe('export')
  })

  it('caps the length', () => {
    expect(sanitizeFilename('a'.repeat(500)).length).toBeLessThanOrEqual(LIMITS.filename)
  })
})

describe('urls', () => {
  it('accepts only absolute http(s)', () => {
    expect(sanitizeUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com/')
  })

  it('rejects every scheme that can execute', () => {
    for (const payload of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\nscript:alert(1)',
      'java\tscript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//evil.example/path',
      'not a url',
      '',
    ]) {
      expect(sanitizeUrl(payload), `${payload} was accepted`).toBeNull()
    }
  })

  it('rejects an over-long URL rather than truncating it into something else', () => {
    expect(sanitizeUrl(`https://example.com/${'a'.repeat(LIMITS.url)}`)).toBeNull()
  })
})

describe('output escaping', () => {
  it('escapes the five characters that matter in a text node', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  it('escapes backtick, equals and newline in an attribute', () => {
    expect(escapeAttribute('a`b=c')).toBe('a&#96;b&#61;c')
    expect(escapeAttribute('a\nb')).toBe('a b')
  })

  it('escapes a JSON-LD payload so it cannot close its script tag', () => {
    const escaped = escapeJsonLd({ x: '</script><script>alert(1)</script>', y: 'a\u2028b' })
    expect(escaped).not.toContain('</script>')
    expect(escaped).not.toContain('\u2028')
    expect(JSON.parse(escaped)).toEqual({ x: '</script><script>alert(1)</script>', y: 'a\u2028b' })
  })
})

describe('slugs', () => {
  it('folds a title to a URL-safe stem', () => {
    expect(slugStem('Survey Rover Mk II')).toBe('survey-rover-mk-ii')
    expect(slugStem('Modèle Épique')).toBe('modele-epique')
    expect(slugStem('!!!')).toBe('')
    expect(slugStem('<script>')).toBe('script')
  })

  it('accepts only a slug shape in a URL', () => {
    expect(isValidSlug('survey-rover-abc123')).toBe(true)
    for (const bad of [
      '../secrets',
      'Survey-Rover',
      'a'.repeat(200),
      '-leading',
      'double--dash',
      'trailing/',
      '',
      null,
      42,
    ]) {
      expect(isValidSlug(bad), `${String(bad)} was accepted`).toBe(false)
    }
  })
})

describe('payload guards', () => {
  it('refuses an oversized body before it is parsed', () => {
    expect(() => guardPayloadSize(1024)).not.toThrow()
    expect(() => guardPayloadSize(LIMITS.payloadBytes + 1)).toThrow(/over the/)
    expect(() => guardPayloadSize(Number.NaN)).toThrow(/finite/)
    expect(() => guardPayloadSize(-1)).toThrow(/finite/)
  })
})
