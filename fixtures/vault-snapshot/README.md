# Gate 3 knowledge snapshot

This directory is the bounded, read-only source-of-truth fixture for the Gate 3
CEO replay. It stands in for configured knowledge/vault access while the real
connector is not present.

The specialist receives a logical `workspace/knowledge/...` resource and the
fixture adapter maps that resource to a file below this directory. The adapter
permits only the exact allowlisted resource and performs no writes or network
calls. A future knowledge/vault connector can replace this adapter without
changing the CEO workspace, signed message, delegation, gateway, policy, or
audit contracts. That is the same model-freedom boundary used by the CEO model
router.

The fixture is scenario data, not proof of current live model configuration.
Replace it with a fresh, revision-pinned knowledge snapshot when the real
connector is introduced.
