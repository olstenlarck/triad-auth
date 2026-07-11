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

const profileDisclosures: Record<string, Disclosure> = {
  email: {
    label: "EMAIL + VERIFICATION STATUS",
    claim: "email + email_verified",
    description: "Share your email address and its verification status.",
  },
  handle: {
    label: "PROVIDER HANDLE",
    claim: "preferred_username",
    description: "Share the username shown on your provider account.",
  },
  name: {
    label: "DISPLAY NAME",
    claim: "name",
    description: "Share the display name shown on your provider account.",
  },
  avatar: {
    label: "AVATAR",
    claim: "picture",
    description: "Share the profile image from your provider account.",
  },
};

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

export function renderDisclosureControls(container: HTMLElement, scopes: readonly string[]): void {
  if (!scopes.includes("openid")) {
    throw new Error("This request does not include identity.");
  }

  container.replaceChildren();
  for (const disclosure of identityDisclosures) {
    const row = document.createElement("div");
    row.appendChild(disclosureText(disclosure));
    container.appendChild(row);
  }

  for (const scope of scopes.filter((value) => value !== "openid")) {
    const disclosure = profileDisclosures[scope];
    if (!disclosure) {
      throw new Error("This request contains an unsupported claim.");
    }

    const row = document.createElement("label");
    row.className = "disclosure-choice";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "granted-scope";
    input.value = scope;
    input.checked = true;
    input.disabled = true;
    const switchMark = document.createElement("span");
    switchMark.className = "disclosure-switch";
    switchMark.setAttribute("aria-hidden", "true");
    const content = document.createElement("span");
    content.className = "disclosure-copy";
    content.appendChild(disclosureText(disclosure));
    row.appendChild(input);
    row.appendChild(switchMark);
    row.appendChild(content);
    container.appendChild(row);
  }
}
