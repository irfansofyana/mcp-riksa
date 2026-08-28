export class WorkbenchError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502 | 504 = 400, readonly details?: unknown) {
    super(message);
    this.name = 'WorkbenchError';
  }
}
