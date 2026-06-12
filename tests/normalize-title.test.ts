import { describe, expect, it } from 'bun:test';
import { normalizeTitleKey } from '../scripts/lib/normalize-title';

describe('normalizeTitleKey', () => {
  it('collapses width, case, brackets, punctuation and whitespace', () => {
    expect(normalizeTitleKey('鋼の錬金術師 FULLMETAL ALCHEMIST')).toBe(
      '鋼の錬金術師fullmetalalchemist'
    );
    expect(normalizeTitleKey('「進撃の巨人」 Season 3')).toBe('進撃の巨人season3');
    expect(normalizeTitleKey('ＳＴＥＩＮＳ；ＧＡＴＥ')).toBe('steins;gate');
    expect(normalizeTitleKey('!NVADE SHOW!')).toBe('nvadeshow');
  });

  it('returns empty for punctuation-only input', () => {
    expect(normalizeTitleKey('!?。・')).toBe('');
  });
});
