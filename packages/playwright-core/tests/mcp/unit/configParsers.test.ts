import { describe, it, expect } from 'vitest';

import {
  semicolonSeparatedList,
  commaSeparatedList,
  numberParser,
  resolutionParser,
  headerParser,
  enumParser,
} from 'playwright-core/src/mcp/config';

describe('semicolonSeparatedList', () => {
  it('returns undefined for falsy input', () => {
    expect(semicolonSeparatedList(undefined)).toBeUndefined();
    expect(semicolonSeparatedList('')).toBeUndefined();
  });

  it('splits on semicolons and trims', () => {
    expect(semicolonSeparatedList('a; b ;c')).toEqual(['a', 'b', 'c']);
  });
});

describe('commaSeparatedList', () => {
  it('returns undefined for falsy input', () => {
    expect(commaSeparatedList(undefined)).toBeUndefined();
    expect(commaSeparatedList('')).toBeUndefined();
  });

  it('splits on commas and trims', () => {
    expect(commaSeparatedList('x, y ,z')).toEqual(['x', 'y', 'z']);
  });
});

describe('numberParser', () => {
  it('returns undefined for falsy input', () => {
    expect(numberParser(undefined)).toBeUndefined();
    expect(numberParser('')).toBeUndefined();
  });

  it('coerces string to number', () => {
    expect(numberParser('42')).toBe(42);
    expect(numberParser('3.14')).toBe(3.14);
  });
});

describe('resolutionParser', () => {
  it('returns undefined for falsy input', () => {
    expect(resolutionParser('viewport', undefined)).toBeUndefined();
    expect(resolutionParser('viewport', '')).toBeUndefined();
  });

  it('parses WxH format', () => {
    expect(resolutionParser('viewport', '1920x1080')).toEqual({ width: 1920, height: 1080 });
  });

  it('parses legacy W,H format', () => {
    expect(resolutionParser('viewport', '800,600')).toEqual({ width: 800, height: 600 });
  });

  it('throws on invalid format', () => {
    expect(() => resolutionParser('viewport', 'abc')).toThrow('Invalid resolution format');
  });

  it('throws on invalid dimensions in WxH format', () => {
    expect(() => resolutionParser('viewport', '0x600')).toThrow('Invalid resolution format');
  });
});

describe('headerParser', () => {
  it('returns empty object for falsy input', () => {
    expect(headerParser(undefined)).toEqual({});
  });

  it('parses name:value pairs', () => {
    expect(headerParser('Content-Type: application/json')).toEqual({ 'Content-Type': 'application/json' });
  });

  it('merges into previous object', () => {
    const prev = { 'X-Existing': 'yes' };
    const result = headerParser('X-New: hello', prev);
    expect(result).toEqual({ 'X-Existing': 'yes', 'X-New': 'hello' });
  });
});

describe('enumParser', () => {
  it('returns valid value', () => {
    expect(enumParser('mode', ['a', 'b', 'c'], 'b')).toBe('b');
  });

  it('throws on invalid value', () => {
    expect(() => enumParser('mode', ['a', 'b', 'c'], 'x')).toThrow('Invalid mode: x');
  });
});
