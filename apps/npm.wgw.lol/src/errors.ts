import * as Effect from "effect/Effect";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";

// Every error renders itself as its HTTP response, so the router needs no error mapping.

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}) {
  override readonly message = "Not found";

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.text(this.message, { status: 404 }));
  }
}

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  message: Schema.String,
}) {
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.text(this.message, { status: 400 }));
  }
}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {
  override readonly message = "Unauthorized";

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(
      HttpServerResponse.text(this.message, {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="npm.wgw.lol"' },
      }),
    );
  }
}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {
  override readonly message = "Forbidden";

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.text(this.message, { status: 403 }));
  }
}

export class MethodNotAllowed extends Schema.TaggedError<MethodNotAllowed>()(
  "MethodNotAllowed",
  {},
) {
  override readonly message = "Method not allowed";

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(
      HttpServerResponse.text(this.message, {
        status: 405,
        headers: { allow: "GET, HEAD, PUT, POST, DELETE" },
      }),
    );
  }
}

export class BadGateway extends Schema.TaggedError<BadGateway>()("BadGateway", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.text(this.message, { status: 502 }));
  }
}
