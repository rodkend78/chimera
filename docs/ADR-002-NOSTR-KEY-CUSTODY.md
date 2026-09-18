# ADR-002: Nostr-First Identity With Cloud Signing Custody

**Status:** Accepted for the pilot
**Date:** 2026-08-22

## Decision

Chimera will make Nostr interoperability the first production identity target.
Agent Nostr private keys must remain available when the operator's Mac is off,
but they must never be placed in an agent workspace, browser profile, model
context, container environment variable, repository, or Telegram message.

For the pilot, Chimera will use a dedicated signing broker in AWS:

```text
agent or runtime adapter
  -> signed Chimera action and candidate Nostr event
  -> policy gateway
  -> narrowly authorized signing broker
  -> Secrets Manager encrypted key retrieval
  -> BIP-340 Schnorr signature
  -> signed event and audit receipt
```

The Nostr secret is stored as an encrypted secret under a customer-managed KMS
encryption key. Secrets Manager replication provides a second AWS Region copy.
An optional iCloud or Google Drive recovery artifact may contain only a
separately encrypted recovery bundle, never a plaintext `nsec`.

## Why KMS is not the Nostr signer

Nostr NIP-01 uses BIP-340 Schnorr signatures over `secp256k1`. AWS KMS supports
`ECC_SECG_P256K1`, but its documented signing algorithm for that key spec is
`ECDSA_SHA_256`. The curves match; the signature schemes do not. A normal
asymmetric KMS signing key therefore cannot directly produce a NIP-01 signature.

KMS remains the envelope-encryption and access-control root for the pilot secret.
The broker performs the Nostr-specific signing operation in a small, isolated
process with no model, browser, shell, or general tool access.

## Broker contract

The broker accepts a canonical candidate event plus a Chimera authorization
receipt. It independently verifies:

- the requested public key belongs to the configured agent identity;
- the event digest matches the canonical event;
- the gateway receipt authorizes the exact event and has not expired;
- the event kind and relay destinations are permitted for that agent;
- the request ID has not already been signed;
- the caller has the broker invocation role.

It returns the public key, event ID, signature, request ID, key version, and an
audit correlation ID. It never returns the private key.

## Availability and recovery

- Primary secret: AWS Secrets Manager in the Chimera pilot Region.
- Replica: a second enabled AWS Region with a distinct KMS encryption key.
- Runtime access: only the signing broker role may retrieve the secret.
- Recovery copy: ciphertext only, protected by a separate recovery mechanism.
- Rotation: versioned and explicit because changing a Nostr private key changes
  the public identity. Routine automatic password-style rotation is prohibited.
- Failure mode: signing fails closed if the broker, audit append, policy receipt,
  or current secret version cannot be verified.

This design removes dependence on a local Mac without turning general cloud
storage into a live keystore.

## Pilot limitations and hardening path

The broker process must briefly hold decrypted key material in isolated memory.
That is an accepted pilot limitation, not a claim of hardware-isolated custody.
Before high-consequence production use, evaluate a hardware or enclave-backed
BIP-340 implementation, broker attestation, dual control for recovery, and
independent key-use anomaly detection.

## References

- [Nostr NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [AWS KMS key specification and signing algorithm reference](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html)
- [AWS Secrets Manager cross-Region replication](https://docs.aws.amazon.com/secretsmanager/latest/userguide/replicate-secrets.html)
- [AWS Secrets Manager encryption](https://docs.aws.amazon.com/secretsmanager/latest/userguide/security-encryption.html)
