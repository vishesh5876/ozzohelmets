import { csvCell, csvRow } from './csv';

describe('csv', () => {
  it('passes plain values through and renders null/undefined as empty', () => {
    expect(csvRow(['HM-A8F3-KL92', 42, null, undefined])).toBe('HM-A8F3-KL92,42,,\r\n');
  });

  it('quotes separators, quotes and line breaks', () => {
    expect(csvCell('Roadster, X1')).toBe('"Roadster, X1"');
    expect(csvCell('the "best"')).toBe('"the ""best"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
  });
});
