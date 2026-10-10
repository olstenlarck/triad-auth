import type { Env } from "./env";
import { PAGE } from "./page";

export { NcrFloor } from "./floor";

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    // One user, one session: every socket joins the same object.
    if (pathname === "/ws") {
      return env.NcrFloor.getByName("alex").fetch(request);
    }
    if (pathname === "/") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
