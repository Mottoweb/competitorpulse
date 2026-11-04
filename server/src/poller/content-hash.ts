import { createHash } from 'node:crypto';
import type { Listing } from '../source/listing';

export function normalise(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function contentHash(listing: Listing): string {
  // JSON keeps the field boundaries, so text moving between fields changes the hash.
  const canonical = JSON.stringify([
    normalise(listing.title),
    normalise(listing.tagline),
    normalise(listing.price),
    normalise(listing.description),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
