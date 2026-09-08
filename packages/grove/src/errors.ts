export class GroveError extends Error {
  constructor(
    public readonly code: 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GroveError';
  }
  get status(): number {
    return { invalid_request: 400, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409 }[this.code];
  }
}

export function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GroveError('invalid_request', message);
}
