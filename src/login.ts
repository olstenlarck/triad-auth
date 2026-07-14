import type { TriadProvider } from "./ids";

export function loginPage(providers: TriadProvider[]) {
  const buttons = providers
    .map(
      (provider) =>
        `<button type="button" data-provider="${provider}">Continue with ${provider}</button>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Triad Auth</title>
<style>
  :root { color-scheme: dark; font: 16px/1.45 system-ui, sans-serif; background: #0b0b0c; color: #f4f4f5; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
  main { width: min(28rem, calc(100% - 2rem)); padding: 2rem; border: 1px solid #303036; border-radius: 1rem; background: #151518; }
  h1 { margin: 0 0 .35rem; }
  p { color: #a1a1aa; }
  .providers { display: grid; gap: .75rem; margin-top: 1.5rem; }
  button { border: 0; border-radius: .65rem; padding: .85rem 1rem; font: inherit; font-weight: 650; cursor: pointer; text-transform: capitalize; }
  #error { color: #f87171; min-height: 1.45em; }
</style>
</head>
<body>
<main>
  <h1>Sign in to Triad</h1>
  <p>Choose the identity provider for this authorization.</p>
  <div class="providers">${buttons}</div>
  <p id="error" role="alert"></p>
</main>
<script>
  const error = document.querySelector("#error");
  const buttons = [...document.querySelectorAll("[data-provider]")];

  async function signIn(provider) {
    buttons.forEach((button) => { button.disabled = true; });
    error.textContent = "";

    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider,
          oauth_query: location.search.slice(1),
        }),
      });
      const body = await response.json();
      if (!response.ok || !body.url) {
        throw new Error(body.message || body.error_description || "Sign-in failed");
      }
      location.assign(body.url);
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : "Sign-in failed";
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => signIn(button.dataset.provider));
  });
</script>
</body>
</html>`;
}
