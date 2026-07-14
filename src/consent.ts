const SCOPE_COPY: Record<string, string> = {
  openid: "Identify you to this application",
  email: "Share your provider email and verification status",
  handle: "Share your provider handle",
  name: "Share your provider display name",
  avatar: "Share your provider avatar",
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function requestedClaims(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { userinfo?: Record<string, unknown> };
    return parsed.userinfo && typeof parsed.userinfo === "object"
      ? Object.keys(parsed.userinfo)
      : [];
  } catch {
    return [];
  }
}

export function consentPage(query: Record<string, string>) {
  const clientId = query.client_id ?? "Unknown application";
  const scopes = (query.scope ?? "openid").split(/\s+/).filter(Boolean);
  const claims = requestedClaims(query.claims);

  const scopeRows = scopes
    .map((scope) => {
      const label = SCOPE_COPY[scope] ?? `Allow the ${scope} permission`;
      return `<label class="permission"><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked ${scope === "openid" ? "disabled" : ""}><span><strong>${escapeHtml(scope)}</strong><small>${escapeHtml(label)}</small></span></label>`;
    })
    .join("");

  const claimRows = claims.length
    ? `<section><h2>Explicit claims</h2><p class="claims">${claims.map(escapeHtml).join(", ")}</p></section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize application · Triad Auth</title>
<style>
  :root { color-scheme: dark; font: 16px/1.45 system-ui, sans-serif; background: #0b0b0c; color: #f4f4f5; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
  main { width: min(34rem, calc(100% - 2rem)); padding: 2rem; border: 1px solid #303036; border-radius: 1rem; background: #151518; }
  h1 { margin: 0 0 .35rem; font-size: 1.6rem; }
  h2 { margin: 1.5rem 0 .5rem; font-size: .85rem; text-transform: uppercase; letter-spacing: .08em; color: #a1a1aa; }
  .client { margin: 0 0 1.5rem; color: #a1a1aa; overflow-wrap: anywhere; }
  .permissions { display: grid; gap: .65rem; }
  .permission { display: flex; gap: .75rem; padding: .8rem; border: 1px solid #303036; border-radius: .7rem; cursor: pointer; }
  .permission input { margin-top: .25rem; }
  .permission span { display: grid; }
  .permission small, .claims { color: #a1a1aa; }
  .actions { display: flex; gap: .75rem; margin-top: 1.75rem; }
  button { flex: 1; border: 0; border-radius: .65rem; padding: .8rem 1rem; font: inherit; font-weight: 650; cursor: pointer; }
  #approve { background: #f4f4f5; color: #09090b; }
  #deny { background: #29292e; color: #f4f4f5; }
  #error { color: #f87171; min-height: 1.45em; }
</style>
</head>
<body>
<main>
  <h1>Authorize application</h1>
  <p class="client">Application: <strong id="client-name">${escapeHtml(clientId)}</strong></p>
  <section>
    <h2>Requested access</h2>
    <div class="permissions">${scopeRows}</div>
  </section>
  ${claimRows}
  <p id="error" role="alert"></p>
  <div class="actions">
    <button id="deny" type="button">Deny</button>
    <button id="approve" type="button">Allow selected</button>
  </div>
</main>
<script>
  const params = new URLSearchParams(location.search);
  const clientId = params.get("client_id");
  const error = document.querySelector("#error");
  const buttons = [...document.querySelectorAll("button")];

  if (clientId) {
    fetch("/api/auth/oauth2/public-client?client_id=" + encodeURIComponent(clientId), {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
      .then((response) => response.ok ? response.json() : null)
      .then((client) => {
        if (client && client.client_name) {
          document.querySelector("#client-name").textContent = client.client_name;
        }
      })
      .catch(() => {});
  }

  async function decide(accept) {
    buttons.forEach((button) => { button.disabled = true; });
    error.textContent = "";

    const scope = [...document.querySelectorAll('input[name="scope"]:checked')]
      .map((input) => input.value)
      .join(" ");

    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accept,
          scope,
          oauth_query: location.search.slice(1),
        }),
      });
      const body = await response.json();
      const redirect = body.url || body.redirect_uri;
      if (!response.ok || !redirect) {
        throw new Error(body.error_description || body.message || "Consent failed");
      }
      location.assign(redirect);
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : "Consent failed";
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  document.querySelector("#approve").addEventListener("click", () => decide(true));
  document.querySelector("#deny").addEventListener("click", () => decide(false));
</script>
</body>
</html>`;
}
