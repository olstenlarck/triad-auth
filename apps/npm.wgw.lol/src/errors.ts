import * as Effect from "effect/Effect";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";

// Every error response is JSON with one `error` field, the shape the npm registry uses.
export const errorResponse = (
  status: number,
  error: string,
  headers?: Record<string, string>,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers });

// Each error renders itself as its HTTP response, so the routes need no error mapping.

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}) {
  override readonly message = "Not found";

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(errorResponse(404, this.message));
  }
}

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  message: Schema.String,
}) {
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(errorResponse(400, this.message));
  }
}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {
  override readonly message = "Unauthorized";

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(
      errorResponse(401, this.message, { "www-authenticate": 'Bearer realm="npm.wgw.lol"' }),
    );
  }
}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {
  override readonly message = "Forbidden";

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(errorResponse(403, this.message));
  }
}

export class MethodNotAllowed extends Schema.TaggedError<MethodNotAllowed>()(
  "MethodNotAllowed",
  {},
) {
  override readonly message = "Method not allowed";

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(
      errorResponse(405, this.message, { allow: "GET, HEAD, PUT, POST, DELETE" }),
    );
  }
}

export class BadGateway extends Schema.TaggedError<BadGateway>()("BadGateway", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(errorResponse(502, this.message));
  }
}
