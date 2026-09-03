/**
 * Error taxonomy for the Trailhead client.
 *
 * Every failure a caller can reasonably branch on gets its own class, so
 * consumers never have to string-match a message. `TrailheadError` is the
 * common base: `catch (e) { if (e instanceof TrailheadError) … }` covers the
 * whole surface.
 *
 * Errors carry no request or response bodies beyond what is needed to explain
 * the failure — nothing from this package should ever end up logging a
 * profile payload by accident.
 */

export class TrailheadError extends Error {
  override readonly name: string = 'TrailheadError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options && 'cause' in options) {
      // `cause` is ES2022, but assigning it explicitly keeps the property
      // present even when a downlevel target strips the constructor option.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** The handle did not pass `isValidHandle()` — no request was made. */
export class TrailheadInvalidHandleError extends TrailheadError {
  override readonly name = 'TrailheadInvalidHandleError';

  constructor(public readonly handle: string) {
    super(
      `"${handle}" is not a valid Trailhead handle. Expected 1-100 characters of ` +
        `letters, digits, "." "_" or "-".`
    );
  }
}

/** The API resolved the slug to no profile (GraphQL `NOT_FOUND`). */
export class TrailheadProfileNotFoundError extends TrailheadError {
  override readonly name = 'TrailheadProfileNotFoundError';

  constructor(public readonly handle: string) {
    super(`No Trailhead profile found for handle "${handle}".`);
  }
}

/**
 * The profile exists but its owner has not made it public
 * (`__typename: "PrivateProfile"`).
 *
 * This is a hard stop, not a degraded result: the WEB spec forbids reading
 * anything but public Trailhead data, so the client refuses to return a
 * partial profile for a private one.
 */
export class TrailheadProfilePrivateError extends TrailheadError {
  override readonly name = 'TrailheadProfilePrivateError';

  constructor(public readonly handle: string) {
    super(
      `Trailhead profile "${handle}" is private. This client reads public ` +
        `profiles only and will not request private data.`
    );
  }
}

/** The API answered 429, or 503 with a `Retry-After`, after all retries. */
export class TrailheadRateLimitError extends TrailheadError {
  override readonly name = 'TrailheadRateLimitError';

  constructor(
    public readonly status: number,
    /** Seconds from the `Retry-After` header, when the API sent one. */
    public readonly retryAfterSeconds: number | null
  ) {
    super(
      `Trailhead API rate-limited the request (HTTP ${status})` +
        (retryAfterSeconds === null ? '.' : `; retry after ${retryAfterSeconds}s.`)
    );
  }
}

/** Transport failure, non-2xx status, or a body that was not JSON. */
export class TrailheadTransportError extends TrailheadError {
  override readonly name = 'TrailheadTransportError';

  constructor(
    message: string,
    public readonly status: number | null,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

/** HTTP 200 with a GraphQL `errors` array we could not classify further. */
export class TrailheadGraphQLError extends TrailheadError {
  override readonly name = 'TrailheadGraphQLError';

  constructor(
    message: string,
    public readonly errors: readonly { message?: string; extensions?: { code?: string } }[]
  ) {
    super(message);
  }
}
