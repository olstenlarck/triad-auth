# Limit passkeys by identity source

Accounts with a Social Provider as their Identity Source may attach multiple Passkeys that can authenticate the same Triad Account and supply wallet seeds without changing its Identity Source. An account with Passkey as its Identity Source uses one Identity Passkey for both roles and cannot attach more. An account with EVM as its Identity Source already represents an externally controlled wallet, so it cannot attach Passkeys or derive a PRF wallet.
