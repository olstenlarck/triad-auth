# Triad Identity

Triad mediates authentication and selective identity disclosure between an account holder and client applications. Social Provider accounts with Attached Passkeys and accounts with an Identity Passkey can also authorize deterministic wallets without exposing seed or private key material to anyone.

## People and accounts

**Account Holder**:
The person who controls a Triad Account and approves its actions.
_Avoid_: User

**Triad Account**:
An independent Triad identity anchored to one Identity Source. One Account Holder may control several Triad Accounts, but Triad does not link them.
_Avoid_: User, profile, provider account

**Identity Source**:
The origin of a Triad Account: Google, GitHub, Twitter, EVM, or Passkey.
_Avoid_: Provider when referring to all five sources

**Social Provider**:
An external identity provider used as an Identity Source. Triad supports Google, GitHub, and Twitter.
_Avoid_: Identity Source

**EVM Identity Source**:
An externally user controlled EVM wallet that anchors a Triad Account through signatures. Its authentication network does not change the account identity, and it cannot contain Passkeys or derive a PRF wallet.
_Avoid_: EVM Wallet Profile, Ethereum Identity Source, EVM Smart Account, Wallet Passkey

**Source Identifier**:
The immutable identifier supplied or proven by an Identity Source. It establishes continuity with that source.
_Avoid_: Username, email

**Profile Data**:
Optional descriptive data supplied by an Identity Source, such as email, handle, name, or avatar. Profile Data does not establish account identity.
_Avoid_: Identity, account

## Identity subjects

**Account Subject**:
The opaque identifier for one Triad Account across Triad and all client applications. This is the global Triad account identifier.
_Avoid_: User ID, global user ID

**Source Subject**:
The opaque identifier for the account's Identity Source. The protocol exposes it as `provider_sub`.
_Avoid_: Raw provider ID, Provider Subject in domain prose

**Pairwise Subject**:
The opaque identifier for one Triad Account and one Client Application. Another client receives a different Pairwise Subject for the same account.
_Avoid_: Account Subject, Client ID

## Client authorization

**Client Application**:
Software that asks Triad to authenticate an account, disclose claims, or authorize a wallet operation.
_Avoid_: Client when a person or device is meant

**Client ID**:
The stable identifier of a Client Application.
_Avoid_: Pairwise Subject

**Client Registration**:
The accepted metadata that defines a Client Application, including its allowed redirect locations and protocol capabilities.
_Avoid_: Client account

**Protected Resource**:
The API or service for which a Client Application requests authorization.
_Avoid_: Client Application, authorization server

**Disclosure Scope**:
A named permission to disclose a defined set of Identity Claims.
_Avoid_: Claim, provider scope

**Identity Claim**:
A statement about a Triad Account that Triad may disclose under an approved Disclosure Scope.
_Avoid_: Profile Data

**Consent**:
An Account Holder's approval for a Client Application to receive specific Disclosure Scopes for a Protected Resource.
_Avoid_: Sign-in

**Triad Session**:
An authenticated interaction with one Triad Account.
_Avoid_: OAuth token, account

## Device authorization

**Device Request**:
An authorization request started on one device and approved in an authenticated browser with a matching User Code.
_Avoid_: Browser session

**User Code**:
The short value an Account Holder compares and enters to approve a Device Request.
_Avoid_: Device Code

**Device Code**:
The private value that the requesting device redeems after approval.
_Avoid_: User Code

**First-Party Device Request**:
A Device Request that creates a Triad Session for Triad software.
_Avoid_: Client Device Request

**Client Device Request**:
A Device Request that grants scoped OAuth tokens to a registered Client Application.
_Avoid_: First-Party Device Request

## Passkeys and wallets

**Passkey**:
A user-verified, PRF-capable WebAuthn credential used as an Identity Passkey or an Attached Passkey.
_Avoid_: Wallet, Triad Account

**Identity Passkey**:
The sole Passkey of a Triad Account whose Identity Source is Passkey. It both authenticates the account and supplies wallet seeds.
_Avoid_: Passkey Account, Attached Passkey

**Attached Passkey**:
A Passkey added to a Triad Account whose Identity Source is a Social Provider. It can authenticate the account and supply wallet seeds without changing the Identity Source.
_Avoid_: Identity Passkey, Wallet

**Wallet Passkey**:
An Identity Passkey or Attached Passkey while it is selected to supply a Wallet Seed.
_Avoid_: Wallet, Identity Source

**PRF Wallet Authorization**:
The capability through which a Social Provider account with an Attached Passkey or an account with an Identity Passkey derives and uses a wallet.
_Avoid_: Ethereum wallet signing, OAuth authorization

**Wallet Authorization Request**:
A one-time PRF Wallet Authorization request from a Client Application to derive a wallet and sign a bound message with a Wallet Passkey.
_Avoid_: OAuth authorization request

**Wallet Namespace**:
The identity boundary within which a Wallet Passkey produces a deterministic Wallet Seed.
_Avoid_: Wallet Scope

**Account Wallet Namespace**:
A Wallet Namespace shared across Client Applications for one Triad Account. It is based on the Account Subject.
_Avoid_: Global Wallet Namespace

**Client Wallet Namespace**:
A Wallet Namespace limited to one Triad Account and one Client Application. It is based on the Pairwise Subject.
_Avoid_: App account

**Source Wallet Namespace**:
A Wallet Namespace tied to the Identity Source of one Triad Account. It is based on the Source Subject.
_Avoid_: Provider Wallet Namespace

**Wallet Seed**:
The private deterministic root material produced by one Wallet Passkey in one Wallet Namespace. The same Wallet Passkey produces different Wallet Seeds in different namespaces.
_Avoid_: BIP-32 Root, Passkey, private key

**Wallet Profile**:
A required client-selected definition of the key derivation method, standard path template, address format, and signature format for a Derived Wallet.
_Avoid_: Wallet Type, raw path

**EVM Wallet Profile**:
The PRF wallet profile that derives an EVM-compatible address and signing key for an account with an Attached Passkey or Identity Passkey. It is independent of the EVM Identity Source.
_Avoid_: EVM Identity Source, Ethereum Wallet Profile

**Chain ID**:
The EVM network that the Client Application selects for a wallet signature. It defaults to Ethereum mainnet `1` and does not change the Wallet Seed, Derivation Path, private key, or address.
_Avoid_: Wallet Profile, Account Index

**Bitcoin Wallet Profile**:
A Wallet Profile that explicitly selects the Bitcoin address type and network. Generic Bitcoin and default Bitcoin profiles do not exist.
_Avoid_: Bitcoin wallet

**Derivation Path**:
The standard path resolved from a Wallet Profile and Account Index. A Client Application does not supply it directly.
_Avoid_: Raw path, Account Index

**Account Index**:
A client-selected position within a Wallet Profile's path template. It defaults to zero when omitted.
_Avoid_: Derivation Path

**Derived Wallet**:
The signing key and address derived from a Wallet Seed, Wallet Profile, and Account Index.
_Avoid_: Wallet Seed, Wallet Passkey

**Signing Envelope**:
The exact statement that binds a wallet signature to its client, request, namespace, profile, account index, path, applicable Chain ID, message, and lifetime.
_Avoid_: Client message

**Wallet Authorization Result**:
The verifiable address, signature, request identity, namespace, profile, account index, path, applicable Chain ID, and Signing Envelope returned to the Client Application.
_Avoid_: Wallet, OAuth token
