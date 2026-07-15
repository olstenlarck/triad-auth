type Disclosure = {
  label: string;
  claim: string;
  description: string;
};

const identityDisclosures: readonly Disclosure[] = [
  {
    label: "APP-SCOPED ID",
    claim: "pairwise_sub",
    description: "Unique to this application. A different client receives a different value.",
  },
  {
    label: "BROKER ACCOUNT",
    claim: "account_sub",
    description: "Stable across Triad clients that you authorize.",
  },
  {
    label: "PROVIDER IDENTITY",
    claim: "provider_sub",
    description: "Stable for this provider without exposing its raw account ID.",
  },
];

function disclosureText(disclosure: Disclosure): DocumentFragment {
  const content = document.createDocumentFragment();
  const label = document.createElement("span");
  const claim = document.createElement("strong");
  const description = document.createElement("small");

  label.textContent = disclosure.label;
  claim.textContent = disclosure.claim;
  description.textContent = disclosure.description;
  content.appendChild(label);
  content.appendChild(claim);
  content.appendChild(description);

  return content;
}

export function renderDisclosures(container: HTMLElement, scopes: readonly string[]): void {
  if (scopes.length !== 1 || scopes[0] !== "openid") {
    throw new Error("This request contains an unsupported scope.");
  }

  container.replaceChildren();

  for (const disclosure of identityDisclosures) {
    const row = document.createElement("div");
    row.appendChild(disclosureText(disclosure));
    container.appendChild(row);
  }
}
