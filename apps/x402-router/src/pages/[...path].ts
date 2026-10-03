import type { APIRoute } from "astro";

import { routerApi } from "../router-api";

export const prerender = false;

export const GET: APIRoute = ({ request }) => routerApi(request);
export const POST: APIRoute = ({ request }) => routerApi(request);
export const OPTIONS: APIRoute = ({ request }) => routerApi(request);
