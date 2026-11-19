# Bundled libraries

`anthropic-sdk.js` is the official Anthropic SDK for JavaScript (`@anthropic-ai/sdk` 1.9.0, Apache-2.0),
bundled into one file so the app needs no build step. It is loaded only when someone chooses Claude for
"Get facts". To rebuild it:

```bash
npm install @anthropic-ai/sdk esbuild
printf "export { default } from '@anthropic-ai/sdk';\n" > entry.js
npx esbuild entry.js --bundle --format=esm --minify --target=es2022 --platform=browser --outfile=anthropic-sdk.js
```
