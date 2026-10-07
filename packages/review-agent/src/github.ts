// The token stays in this process. The agent's shell does not inherit it, so the model reaches
// GitHub only through the tools that call this function.
export async function github(path: string, body: unknown): Promise<void> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify(body),
  });
  // GraphQL reports errors with a 200 status.
  const result: { errors?: unknown } = await response.json();
  if (!response.ok || result.errors) {
    throw new Error(`GitHub ${path} returned ${response.status}: ${JSON.stringify(result)}`);
  }
}
