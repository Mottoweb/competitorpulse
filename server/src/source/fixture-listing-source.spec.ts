import { loadFixtures, parseFixtures } from './fixture-listing-source';

const listing = {
  title: 'Acme',
  tagline: 'Fast',
  price: '$1',
  description: 'A listing',
};

describe('parseFixtures', () => {
  it('accepts a sequence of listings per competitor', () => {
    expect(parseFixtures({ acme: [listing] })).toEqual({ acme: [listing] });
  });

  it('rejects a listing with a missing field', () => {
    expect(() =>
      parseFixtures({ acme: [{ title: 'Acme', tagline: 'Fast', price: '$1' }] }),
    ).toThrow();
  });

  it('rejects a competitor with no versions', () => {
    expect(() => parseFixtures({ acme: [] })).toThrow();
  });
});

describe('loadFixtures', () => {
  it('loads the provided fixtures: 3 competitors with 4 versions each', () => {
    const fixtures = loadFixtures();

    expect(Object.keys(fixtures).sort()).toEqual([
      'acme-crm',
      'ferry-pay',
      'north-analytics',
    ]);
    expect(Object.values(fixtures).map((versions) => versions.length)).toEqual([
      4, 4, 4,
    ]);
  });
});
