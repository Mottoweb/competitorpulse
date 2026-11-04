import type { Listing } from '../source/listing';
import { contentHash } from './content-hash';

const listing: Listing = {
  title: 'Acme CRM',
  tagline: 'Simple CRM for small teams',
  price: '$29/mo',
  description: 'Track leads and deals in one place.',
};

describe('contentHash', () => {
  it('is a SHA-256 hex digest', () => {
    expect(contentHash(listing)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same listing', () => {
    expect(contentHash({ ...listing })).toBe(contentHash(listing));
  });

  it('ignores whitespace-only differences', () => {
    expect(
      contentHash({
        title: '  Acme   CRM ',
        tagline: 'Simple CRM\nfor small\tteams',
        price: ' $29/mo',
        description: 'Track leads  and deals in one place.  ',
      }),
    ).toBe(contentHash(listing));
  });

  it.each(['title', 'tagline', 'price', 'description'] as const)(
    'changes when %s changes',
    (field) => {
      expect(contentHash({ ...listing, [field]: 'different' })).not.toBe(
        contentHash(listing),
      );
    },
  );

  it('does not confuse text moving between fields', () => {
    expect(contentHash({ ...listing, title: 'a b', tagline: 'c' })).not.toBe(
      contentHash({ ...listing, title: 'a', tagline: 'b c' }),
    );
  });
});
