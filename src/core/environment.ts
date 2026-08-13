import { z } from 'zod';

export const environmentVariableNameSchema = z.string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Expected an environment variable name');
