---
'@hjewkes/active-work': patch
---

Trim published dependencies so a global install stays lean. The React
dashboard is inlined into `dist/dashboard/index.html` at build time, so its
libraries are build-only: `react`, `react-dom`, and `react-native-web` move to
`devDependencies`, and the unused `@titan-design/react-ui`, `lucide-react`,
`mustache`, `uuid`, `zod-to-json-schema`, and `@commander-js/extra-typings` are
dropped from runtime deps entirely (`zod-to-json-schema` was superseded by
native `z.toJSONSchema`; the CLI uses `crypto.randomUUID`). `npm i -g` no longer
pulls `react-native-web` and friends. Verified by installing the packed tarball
with `--omit=dev` and running the CLI.
