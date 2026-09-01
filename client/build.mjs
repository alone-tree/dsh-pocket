// dsh-pocket 网页客户端打包：client/index.jsx → client/client.js
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDir, '..');
const outputPath = resolve(packageRoot, 'client/client.js');
const loaderId = process.env.DSH_POCKET_CLIENT_ID ?? 'dsh-pocket';

const result = await build({
  entryPoints: [resolve(sourceDir, 'index.jsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});

const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // The DSH client module system provides react as a module, never as a
    // global. esbuild keeps react external (see the build config above) and
    // its classic JSX transform emits bare React.createElement calls for the
    // mobile components (which import only named hooks, not React itself), so
    // the bundle must bind React itself - otherwise every mobile component
    // crashes at render time with "ReferenceError: React is not defined".
    var React = require("react");
${bundled}
    return module.exports;
  }
});
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
console.log(`Wrote ${outputPath}`);

// 未登录页使用的独立 Passkey 客户端。它不能依赖 DSH 自己的模块加载器，
// 因为通过设备验证之前不会向浏览器暴露 DSH 页面与资源。
const passkeyOutputPath = resolve(packageRoot, 'client/passkey.js');
const passkeyResult = await build({
  entryPoints: [resolve(sourceDir, 'passkey-entry.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome100', 'safari15'],
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});
const passkeyBundle = passkeyResult.outputFiles?.[0]?.text;
if (!passkeyBundle) throw new Error('esbuild did not produce a passkey bundle');
await writeFile(passkeyOutputPath, passkeyBundle, 'utf8');
console.log(`Wrote ${passkeyOutputPath}`);
