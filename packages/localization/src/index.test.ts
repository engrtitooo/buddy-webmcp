import { describe, expect, it } from 'vitest';
import { detectLocale, directionFor } from './index';
describe('localization', () => {
  it('detects languages and RTL', () => {
    expect(detectLocale('ar-SA')).toBe('ar'); expect(detectLocale('es-MX')).toBe('es');
    expect(detectLocale('fr-FR')).toBe('en'); expect(directionFor('ar')).toBe('rtl');
  });
});
