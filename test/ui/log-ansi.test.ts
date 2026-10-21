import { describe, expect, test } from 'bun:test'
import { ansiSegments } from '../../src/views/log-ansi'
import { ansiHtml } from '../../src/views/job'

const ESC = '\x1b'

describe('ANSI colours', () => {
  test("GitHub's command echo (36;1) is one cyan bold segment; reset ends it", () => {
    expect(ansiSegments(`${ESC}[36;1mbundle exec standardrb${ESC}[0m`)).toEqual([{ text: 'bundle exec standardrb', cls: 'ansi-fg-6 ansi-bold' }])
    expect(ansiSegments(`a${ESC}[31mred${ESC}[0m b`)).toEqual([
      { text: 'a', cls: '' },
      { text: 'red', cls: 'ansi-fg-1' },
      { text: ' b', cls: '' },
    ])
  })

  test('16 colours, backgrounds, bold/italic/underline and their own resets', () => {
    expect(ansiSegments(`${ESC}[92;41;3;4mx${ESC}[23;24;39my${ESC}[49;22mz`)).toEqual([
      { text: 'x', cls: 'ansi-fg-10 ansi-bg-1 ansi-italic ansi-underline' },
      { text: 'y', cls: 'ansi-bg-1' },
      { text: 'z', cls: '' },
    ])
    expect(ansiSegments(`${ESC}[1mb${ESC}[mplain`)).toEqual([
      { text: 'b', cls: 'ansi-bold' },
      { text: 'plain', cls: '' },
    ])
    expect(ansiSegments(`${ESC}[105mbright bg`)).toEqual([{ text: 'bright bg', cls: 'ansi-bg-13' }])
  })

  test('unknown codes, 256 and true colour, cursor moves and stray control characters are dropped', () => {
    expect(ansiSegments(`${ESC}[38;5;208morange${ESC}[0m ${ESC}[38;2;1;2;3;1mrgb bold`)).toEqual([
      { text: 'orange ', cls: '' },
      { text: 'rgb bold', cls: 'ansi-bold' },
    ])
    expect(ansiSegments(`${ESC}[2K${ESC}[1Gprogress\r ${ESC}[?25lok${ESC}x\x07`)).toEqual([{ text: 'progress okx', cls: '' }])
    expect(ansiSegments(`${ESC}[7;5;99mswapped`)).toEqual([{ text: 'swapped', cls: '' }])
    expect(ansiSegments('tab\tstays')).toEqual([{ text: 'tab\tstays', cls: '' }])
  })

  test('HTML: every segment escaped, only known classes; nothing raw survives', () => {
    expect(ansiHtml(`${ESC}[31m<script>alert(1)</script>${ESC}[0m & "q"`)).toBe('<span class="ansi-fg-1">&lt;script&gt;alert(1)&lt;/script&gt;</span> &amp; &quot;q&quot;')
    // a broken sequence is text: the escape character goes, the rest is escaped
    expect(ansiHtml(`${ESC}[31;"onmouseover=x m`)).toBe('[31;&quot;onmouseover=x m')
  })
})
