import { z } from 'zod';

export const listingSchema = z.object({
  title: z.string(),
  tagline: z.string(),
  price: z.string(),
  description: z.string(),
});

export type Listing = z.infer<typeof listingSchema>;
