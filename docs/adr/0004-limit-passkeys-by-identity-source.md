# Limit passkeys by identity source

Accounts with a Social Provider as their Identity Source may attach multiple Passkeys that can authenticate the Social Provider, and can supply wallet seeds without changing the source. An account with Passkey as its Identity Source uses one Identity Passkey for both roles and cannot attach more, while an account with Ethereum as its Identity Source uses its existing Ethereum wallet and cannot attach Passkeys.
