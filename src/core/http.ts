import { z } from 'zod';

export const httpHeaderNameSchema = z.string().regex(
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/,
  'Invalid HTTP header name',
);
