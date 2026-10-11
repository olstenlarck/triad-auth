import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  request: Request;
  env: AppEnv;
  ctx: ExecutionContext;
}

// Server functions read the live request and ExecutionContext from here.
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequest(): RequestContext {
  const store = requestContext.getStore();
  if (!store) {
    throw new Error("no request context");
  }

  return store;
}
