# Third-party notices and dependency inventory

This source beta contains original Chimera source and project documentation. It does not vendor node_modules/, dependency source, app/dist/, or the optional NICE/Amazon DCV web-client SDK. The inventory below is generated from the committed package-lock.json (lockfile version 3) and records every installed lock entry, including platform-specific optional packages. It is a review aid, not a relicensing notice.

## Original source

Chimera original source is licensed under the Apache License, Version 2.0; see LICENSE and NOTICE. Third-party packages retain the license shown by their package metadata and upstream license files. A package's Apache-2.0 metadata does not relicense an external tool, hosted service, model, account, or end-user agreement.

## Inventory scope and counts

The lock contains 274 package entries. Counts by declared license are: Apache-2.0 88, MIT 153, BSD-3-Clause 10, ISC 8, 0BSD 2, MPL-2.0 12, and Unlicense 1. Versions are exact as recorded in the lockfile on this release branch.

Direct runtime and development dependencies are:

- @aws-sdk/client-bedrock@3.1120.0 (Apache-2.0)
- @aws-sdk/client-bedrock-agentcore@3.1121.0 (Apache-2.0)
- @aws-sdk/client-bedrock-runtime@3.1120.0 (Apache-2.0)
- @aws-sdk/client-dynamodb@3.1120.0 (Apache-2.0)
- @aws-sdk/client-lambda@3.1120.0 (Apache-2.0)
- @aws-sdk/client-s3@3.1120.0 (Apache-2.0)
- @aws-sdk/client-secrets-manager@3.1120.0 (Apache-2.0)
- @aws-sdk/client-ssm@3.1120.0 (Apache-2.0)
- @aws-sdk/credential-provider-node@3.972.81 (Apache-2.0)
- @aws-sdk/s3-request-presigner@3.1120.0 (Apache-2.0)
- @cloudscape-design/components@3.0.1356 (Apache-2.0)
- @cloudscape-design/design-tokens@3.0.109 (Apache-2.0)
- @cloudscape-design/global-styles@1.0.67 (Apache-2.0)
- @openai/codex-sdk@0.150.1 (Apache-2.0)
- @smithy/signature-v4@5.7.3 (Apache-2.0)
- esbuild@0.28.2 (MIT)
- @vitejs/plugin-react@6.1.0 (MIT)
- bedrock-agentcore@0.4.3 (Apache-2.0)
- lucide-react@1.33.0 (ISC)
- nostr-tools@2.24.3 (Unlicense)
- playwright@1.62.1 (Apache-2.0)
- prop-types@15.8.1 (MIT)
- react@19.2.8 (MIT)
- react-dom@19.2.8 (MIT)
- vite@8.2.2 (MIT)
- ws@8.21.3 (MIT)

## License-specific inventory

The following lists use the lockfile package path. Nested entries are intentionally retained because they can carry a different version from their top-level package.

### 0BSD (2 entries)

- @aws-crypto/crc32/node_modules/tslib@1.14.1
- tslib@2.8.1

### Apache-2.0 (88 entries)

- @aws-crypto/crc32@3.0.0
- @aws-crypto/crc32/node_modules/@aws-crypto/util@3.0.0
- @aws-crypto/sha256-js@5.2.0
- @aws-crypto/util@5.2.0
- @aws-crypto/util/node_modules/@smithy/util-utf8@2.3.0
- @aws-sdk/checksums@3.1000.29
- @aws-sdk/client-bedrock@3.1120.0
- @aws-sdk/client-bedrock-agentcore@3.1121.0
- @aws-sdk/client-bedrock-agentcore-control@3.1121.0
- @aws-sdk/client-bedrock-runtime@3.1120.0
- @aws-sdk/client-bedrock-runtime/node_modules/@aws-sdk/token-providers@3.1120.0
- @aws-sdk/client-bedrock/node_modules/@aws-sdk/token-providers@3.1120.0
- @aws-sdk/client-dynamodb@3.1120.0
- @aws-sdk/client-lambda@3.1120.0
- @aws-sdk/client-s3@3.1120.0
- @aws-sdk/client-secrets-manager@3.1120.0
- @aws-sdk/client-ssm@3.1120.0
- @aws-sdk/core@3.977.9
- @aws-sdk/credential-provider-cognito-identity@3.972.69
- @aws-sdk/credential-provider-env@3.972.70
- @aws-sdk/credential-provider-http@3.972.72
- @aws-sdk/credential-provider-ini@3.973.15
- @aws-sdk/credential-provider-login@3.972.77
- @aws-sdk/credential-provider-node@3.972.81
- @aws-sdk/credential-provider-process@3.972.70
- @aws-sdk/credential-provider-sso@3.973.14
- @aws-sdk/credential-provider-web-identity@3.972.76
- @aws-sdk/credential-providers@3.1121.0
- @aws-sdk/dynamodb-codec@3.973.44
- @aws-sdk/endpoint-cache@3.972.11
- @aws-sdk/eventstream-codec@3.370.0
- @aws-sdk/eventstream-codec/node_modules/@aws-sdk/types@3.370.0
- @aws-sdk/eventstream-codec/node_modules/@smithy/types@1.2.0
- @aws-sdk/eventstream-handler-node@3.972.34
- @aws-sdk/is-array-buffer@3.310.0
- @aws-sdk/middleware-endpoint-discovery@3.972.30
- @aws-sdk/middleware-eventstream@3.972.29
- @aws-sdk/middleware-sdk-s3@3.972.75
- @aws-sdk/middleware-websocket@3.972.52
- @aws-sdk/nested-clients@3.997.44
- @aws-sdk/protocol-http@3.370.0
- @aws-sdk/protocol-http/node_modules/@aws-sdk/types@3.370.0
- @aws-sdk/protocol-http/node_modules/@smithy/types@1.2.0
- @aws-sdk/s3-request-presigner@3.1120.0
- @aws-sdk/signature-v4@3.370.0
- @aws-sdk/signature-v4-multi-region@3.996.46
- @aws-sdk/signature-v4/node_modules/@aws-sdk/types@3.370.0
- @aws-sdk/signature-v4/node_modules/@smithy/types@1.2.0
- @aws-sdk/token-providers@3.1116.0
- @aws-sdk/types@3.974.5
- @aws-sdk/util-buffer-from@3.310.0
- @aws-sdk/util-hex-encoding@3.310.0
- @aws-sdk/util-middleware@3.370.0
- @aws-sdk/util-uri-escape@3.310.0
- @aws-sdk/util-utf8@3.310.0
- @aws-sdk/util-utf8-browser@3.259.0
- @aws-sdk/xml-builder@3.972.40
- @aws/lambda-invoke-store@0.3.0
- @cloudscape-design/collection-hooks@1.0.107
- @cloudscape-design/component-toolkit@1.0.0-beta.183
- @cloudscape-design/components@3.0.1356
- @cloudscape-design/design-tokens@3.0.109
- @cloudscape-design/global-styles@1.0.67
- @cloudscape-design/test-utils-core@1.0.89
- @cloudscape-design/theming-runtime@1.0.127
- @material/material-color-utilities@0.3.0
- @openai/codex@0.150.1
- @openai/codex-darwin-arm64@0.150.1-darwin-arm64
- @openai/codex-darwin-x64@0.150.1-darwin-x64
- @openai/codex-linux-arm64@0.150.1-linux-arm64
- @openai/codex-linux-x64@0.150.1-linux-x64
- @openai/codex-sdk@0.150.1
- @openai/codex-win32-arm64@0.150.1-win32-arm64
- @openai/codex-win32-x64@0.150.1-win32-x64
- @smithy/core@3.33.3
- @smithy/credential-provider-imds@4.5.2
- @smithy/fetch-http-handler@5.7.2
- @smithy/is-array-buffer@2.2.0
- @smithy/node-http-handler@4.11.3
- @smithy/protocol-http@5.6.2
- @smithy/signature-v4@5.7.3
- @smithy/types@4.17.2
- @smithy/util-buffer-from@2.2.0
- @smithy/util-utf8@4.5.2
- bedrock-agentcore@0.4.3
- detect-libc@2.1.2
- playwright@1.62.1
- playwright-core@1.62.1

### BSD-3-Clause (10 entries)

- ace-builds@1.44.0
- ajv/node_modules/fast-uri@3.1.6
- d3-path@1.0.9
- d3-shape@1.3.7
- fast-uri@4.1.3
- intl-messageformat@10.7.18
- light-my-request@6.6.0
- react-transition-group@4.4.5
- secure-json-parse@4.1.0
- source-map-js@1.2.1

### ISC (8 entries)

- fastq@1.20.3
- inherits@2.0.4
- lucide-react@1.33.0
- once@1.4.0
- picocolors@1.1.1
- semver@7.8.5
- split2@4.2.0
- wrappy@1.0.2

### MIT (153 entries)

- @babel/runtime@7.29.7
- @cloudscape-design/component-toolkit/node_modules/weekstart@2.0.0
- @cloudscape-design/components/node_modules/react-is@18.3.1
- @dnd-kit/accessibility@3.1.1
- @dnd-kit/core@6.3.1
- @dnd-kit/sortable@7.0.2
- @dnd-kit/utilities@3.2.2
- @esbuild/aix-ppc64@0.28.2
- @esbuild/android-arm@0.28.2
- @esbuild/android-arm64@0.28.2
- @esbuild/android-x64@0.28.2
- @esbuild/darwin-arm64@0.28.2
- @esbuild/darwin-x64@0.28.2
- @esbuild/freebsd-arm64@0.28.2
- @esbuild/freebsd-x64@0.28.2
- @esbuild/linux-arm@0.28.2
- @esbuild/linux-arm64@0.28.2
- @esbuild/linux-ia32@0.28.2
- @esbuild/linux-loong64@0.28.2
- @esbuild/linux-mips64el@0.28.2
- @esbuild/linux-ppc64@0.28.2
- @esbuild/linux-riscv64@0.28.2
- @esbuild/linux-s390x@0.28.2
- @esbuild/linux-x64@0.28.2
- @esbuild/netbsd-arm64@0.28.2
- @esbuild/netbsd-x64@0.28.2
- @esbuild/openbsd-arm64@0.28.2
- @esbuild/openbsd-x64@0.28.2
- @esbuild/openharmony-arm64@0.28.2
- @esbuild/sunos-x64@0.28.2
- @esbuild/win32-arm64@0.28.2
- @esbuild/win32-ia32@0.28.2
- @esbuild/win32-x64@0.28.2
- @fastify/ajv-compiler@4.0.6
- @fastify/error@4.2.0
- @fastify/fast-json-stringify-compiler@5.1.0
- @fastify/forwarded@3.0.2
- @fastify/merge-json-schemas@0.2.1
- @fastify/proxy-addr@5.1.0
- @fastify/sse@0.4.0
- @fastify/websocket@11.3.0
- @fastify/websocket/node_modules/fastify-plugin@6.0.0
- @formatjs/ecma402-abstract@2.3.6
- @formatjs/fast-memoize@2.2.7
- @formatjs/icu-messageformat-parser@2.11.4
- @formatjs/icu-skeleton-parser@1.8.16
- @formatjs/intl-localematcher@0.6.2
- @noble/ciphers@2.1.1
- @noble/curves@2.0.1
- @noble/hashes@2.0.1
- @oxc-project/types@0.146.0
- @pinojs/redact@0.4.0
- @rolldown/binding-android-arm-eabi@1.2.5
- @rolldown/binding-android-arm64@1.2.5
- @rolldown/binding-darwin-arm64@1.2.5
- @rolldown/binding-darwin-x64@1.2.5
- @rolldown/binding-freebsd-x64@1.2.5
- @rolldown/binding-linux-arm-gnueabihf@1.2.5
- @rolldown/binding-linux-arm64-gnu@1.2.5
- @rolldown/binding-linux-arm64-musl@1.2.5
- @rolldown/binding-linux-ppc64-gnu@1.2.5
- @rolldown/binding-linux-s390x-gnu@1.2.5
- @rolldown/binding-linux-x64-gnu@1.2.5
- @rolldown/binding-linux-x64-musl@1.2.5
- @rolldown/binding-openharmony-arm64@1.2.5
- @rolldown/binding-win32-arm64-msvc@1.2.5
- @rolldown/binding-win32-x64-msvc@1.2.5
- @rolldown/pluginutils@1.0.1
- @scure/base@2.0.0
- @scure/bip32@2.0.1
- @scure/bip39@2.0.1
- @types/node@26.4.0
- @types/ws@8.18.1
- @vitejs/plugin-react@6.1.0
- abstract-logging@2.0.1
- ajv@8.20.0
- ajv-formats@3.0.1
- atomic-sleep@1.0.0
- avvio@9.3.0
- bowser@2.14.1
- clsx@1.2.1
- cookie@1.1.1
- css-selector-tokenizer@0.8.0
- css.escape@1.5.1
- cssesc@3.0.0
- csstype@3.2.3
- date-fns@2.30.0
- decimal.js@10.6.0
- dequal@2.0.3
- dom-helpers@5.2.1
- duplexify@4.1.3
- end-of-stream@1.4.5
- esbuild@0.28.2
- fast-decode-uri-component@1.0.1
- fast-deep-equal@3.1.3
- fast-json-stringify@7.0.1
- fast-querystring@1.1.2
- fastify@5.12.1
- fastify-plugin@5.1.0
- fastparse@1.1.2
- fdir@6.5.0
- find-my-way@9.9.0
- fsevents@2.3.2
- ipaddr.js@2.5.0
- js-tokens@4.0.0
- json-schema-ref-resolver@3.0.0
- json-schema-traverse@1.0.0
- light-my-request/node_modules/process-warning@4.0.1
- loose-envify@1.4.0
- mnemonist@0.38.3
- mnth@2.0.0
- nanoid@3.3.18
- nostr-wasm@0.1.0
- object-assign@4.1.1
- obliterator@1.6.1
- on-exit-leak-free@2.1.2
- picomatch@4.0.5
- pino@10.3.1
- pino-abstract-transport@3.0.0
- pino-std-serializers@7.1.0
- postcss@8.5.26
- process-warning@5.1.0
- prop-types@15.8.1
- quick-format-unescaped@4.0.4
- react@19.2.8
- react-dom@19.2.8
- react-is@16.13.1
- readable-stream@3.6.2
- real-require@0.2.0
- require-from-string@2.0.2
- ret@0.5.0
- reusify@1.1.0
- rfdc@1.4.1
- rolldown@1.2.5
- safe-buffer@5.2.1
- safe-regex2@5.1.1
- safe-stable-stringify@2.5.0
- scheduler@0.27.0
- set-cookie-parser@2.7.2
- sonic-boom@4.2.1
- stream-shift@1.0.3
- string_decoder@1.3.0
- thread-stream@4.2.0
- thread-stream/node_modules/real-require@1.0.0
- tinyglobby@0.2.17
- toad-cache@3.7.4
- undici-types@8.3.0
- util-deprecate@1.0.2
- vite@8.2.2
- vite/node_modules/fsevents@2.3.3
- weekstart@1.1.0
- ws@8.21.3
- zod@4.5.4

### MPL-2.0 (12 entries)

- lightningcss@1.33.0
- lightningcss-android-arm64@1.33.0
- lightningcss-darwin-arm64@1.33.0
- lightningcss-darwin-x64@1.33.0
- lightningcss-freebsd-x64@1.33.0
- lightningcss-linux-arm-gnueabihf@1.33.0
- lightningcss-linux-arm64-gnu@1.33.0
- lightningcss-linux-arm64-musl@1.33.0
- lightningcss-linux-x64-gnu@1.33.0
- lightningcss-linux-x64-musl@1.33.0
- lightningcss-win32-arm64-msvc@1.33.0
- lightningcss-win32-x64-msvc@1.33.0

### Unlicense (1 entries)

- nostr-tools@2.24.3

## MPL-2.0 obligations

The twelve MPL-2.0 entries are lightningcss@1.33.0 and its eleven platform packages listed above. The Mozilla Public License 2.0 remains applicable to those packages; do not combine their license with Chimera's Apache notice or remove their source/notice obligations. This repository does not copy their source. A future source distribution that changes or redistributes those packages must preserve the MPL notices and applicable source-availability terms.

## External source and tools

- upstream/deepseek-harness.lock.json records an external DeepSeek Harness MIT source at the pinned revision documented in that file. No DeepSeek source is copied here; the upstream license remains applicable if an operator separately obtains that source.
- The local development/test toolchain includes Node.js/npm, Git, Playwright browser downloads, and optional Codex CLI and AWS CLI installations. Linux local Harness execution additionally requires the host's /usr/bin/bwrap (Bubblewrap). These tools and hosted provider services have their own licenses, terms, accounts, quotas, and charges; they are not all dependencies licensed by this repository.
- Optional Google, AWS, Antigravity, Hermes, RJ AWS, and media connectors use the operator's explicitly configured accounts and infrastructure. Their provider terms and costs remain the operator's responsibility.

## Optional managed Live View and DCV terms

bedrock-agentcore@0.4.3 is Apache-2.0 according to its package metadata, but its distribution includes the NICE/Amazon DCV web-client SDK under a separate NICE/Amazon DCV EULA v8.4. That EULA is not Apache-2.0 and is not an open-source license. npm ci installs this SDK inside the ignored local node_modules/ tree, and npm run build may copy it into the ignored local app/dist/ tree for local use; neither output is part of this source release.

Before distributing a built application that includes managed Live View, the distributor must review and satisfy the current DCV EULA and publisher obligations, retain the SDK's EULA and third-party notices in the built distribution, and provide any required end-user agreement or attribution. Do not describe the complete installed dependency tree as open source solely from npm metadata.

## Project assets and future distributions

The animal portraits are project-generated assets described in docs/AGENT_PORTRAITS.md. The mountain illustration is original code-authored artwork at app/public/research-mountain.svg. These are not third-party package source. Any future built application, binary, or bundled artifact requires a fresh dependency/license review and must carry applicable third-party licenses, MPL notices/source availability, and the separate DCV EULA/notices when that SDK is present.

## Reproducibility

To regenerate an equivalent dependency tree, use the committed lockfile with npm ci. Do not commit generated node_modules/, browser caches, runtime state, .chimera/, .env, credentials, or provider data.
