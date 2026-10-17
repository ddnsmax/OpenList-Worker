import path from "path"
import fs from "fs"
import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import legacy from "@vitejs/plugin-legacy"
import { dynamicBase } from "vite-plugin-dynamic-base"
import { viteStaticCopy } from "vite-plugin-static-copy"
import type { Plugin } from "vite"

const dependencyRoot = fs.existsSync(path.resolve(__dirname, "node_modules"))
  ? "node_modules"
  : "../node_modules"

function fixGfmAutolinkLookbehind(): Plugin {
  const incompatible = String.raw`/(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu`
  const compatible = String.raw`/([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu`

  return {
    name: "fix-gfm-autolink-lookbehind",
    enforce: "pre",
    transform(code, id) {
      const normalized = id.replace(/\\/g, "/")
      if (!normalized.includes("mdast-util-gfm-autolink-literal/lib/index.js"))
        return
      if (!code.includes(incompatible))
        throw new Error("GFM autolink compatibility target was not found")
      return code.replace(incompatible, compatible)
    },
  }
}

function fixLegacyPolyfillDataSrc(): Plugin {
  const dynamicAssetLoop =
    /for\(var i = 0; i < preloads\.length; i\+\+\)\{[\s\S]*?document\.getElementsByTagName\(item\.parentTagName\)\[0\]\.appendChild\(childNode\);\n\}/

  return {
    name: "fix-legacy-polyfill-data-src",
    enforce: "post",
    apply: "build",
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === "chunk" && !chunk.fileName.includes("-legacy-")) {
          chunk.code = chunk.code.replace(
            /import'data:text\/javascript,(?:"[^"]+";)?if\(!import\.meta\.resolve\)throw Error\("import\.meta\.resolve not supported"\)';/,
            "",
          )
        }
        if (
          chunk.type === "asset" &&
          chunk.fileName.endsWith(".html") &&
          typeof chunk.source === "string"
        ) {
          chunk.source = chunk.source.replace(
            /("id"\s*:\s*"vite-legacy-polyfill"[^}]*?)"src"\s*:/,
            (match) => match.replace(/"src"\s*:/, '"data-src":'),
          )
          chunk.source = chunk.source.replace(
            /import'data:text\/javascript,if\(!import\.meta\.resolve\)throw Error\("import\.meta\.resolve not supported"\)';/,
            "",
          )
          chunk.source = chunk.source.replace(
            "window.__vite_is_modern_browser=true",
            "window.__vite_is_modern_browser=!window.__openlist_force_legacy__",
          )
          chunk.source = chunk.source.replace(
            dynamicAssetLoop,
            `function isModernAsset(item) {
return item.attrs && (item.attrs.type == 'module' || item.tagName == 'link' && item.attrs.rel == 'modulepreload');
}

function appendAsset(item) {
var childNode = document.createElement(item.tagName);
setAttribute(childNode, item.attrs);
if( window.__dynamic_base__) {
  if(item.tagName == 'link') {
    setAttribute(childNode, { href:  window.__dynamic_base__ + item.attrs.href });
  } else if(item.tagName == 'script') {
    setAttribute(childNode, { src:  window.__dynamic_base__ + (item.attrs.src || item.attrs['data-src']) });
  }
}
document.getElementsByTagName(item.parentTagName)[0].appendChild(childNode);
}
for(var i = 0; i < preloads.length; i++){
if(!isModernAsset(preloads[i])) appendAsset(preloads[i]);
}
function appendModernAssets() {
if(window.__vite_is_modern_browser !== true) return;
for(var i = 0; i < preloads.length; i++){
  if(isModernAsset(preloads[i])) appendAsset(preloads[i]);
}
}
if(document.readyState == 'loading') {
document.addEventListener('DOMContentLoaded', appendModernAssets, { once: true });
} else {
appendModernAssets();
}`,
          )
        }
      }
    },
  }
}

export default defineConfig({
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "src"),
    },
  },
  plugins: [
    fixGfmAutolinkLookbehind(),
    solidPlugin(),
    legacy({
      targets: ["defaults", "iOS >= 12", "Safari >= 12"],
      modernTargets: ["defaults", "iOS >= 16", "Safari >= 16"],
      modernPolyfills: true,
    }),
    dynamicBase({
      publicPath: "window.__dynamic_base__",
      transformIndexHtml: true,
      transformIndexHtmlConfig: {
        insertBodyAfter: true,
      },
    }),
    process.env.VITE_LITE !== "true"
      ? viteStaticCopy({
          targets: [
            {
              src: `${dependencyRoot}/monaco-editor/min/vs/**`,
              dest: "static/monaco-editor",
            },
            {
              src: `${dependencyRoot}/katex/dist/katex.min.css`,
              dest: "static/katex",
            },
            {
              src: `${dependencyRoot}/katex/dist/fonts/*`,
              dest: "static/katex/fonts",
            },
            {
              src: `${dependencyRoot}/mermaid/dist/mermaid.min.js`,
              dest: "static/mermaid",
            },
            {
              src: `${dependencyRoot}/libheif-js/libheif-wasm/libheif.{js,wasm}`,
              dest: "static/libheif",
            },
            {
              src: `${dependencyRoot}/@jellyfin/libass-wasm/dist/js/subtitles-octopus-worker.{js,wasm}`,
              dest: "static/libass-wasm",
            },
            {
              src: "src/components/artplayer-plugin-ass/fonts/*",
              dest: "static/fonts",
            },
          ],
        })
      : null,
    fixLegacyPolyfillDataSrc(),
  ],
  base: process.env.NODE_ENV === "production" ? "/__dynamic_base__/" : "/",
  build: {
    target: ["es2018", "safari12"],
    cssTarget: "safari12",
  },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://localhost:5244",
        changeOrigin: true,
      },
    },
  },
})
