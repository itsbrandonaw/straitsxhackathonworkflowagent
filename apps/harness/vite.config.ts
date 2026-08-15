import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { fileURLToPath } from "node:url";

const liveViewRoot = fileURLToPath(new URL(
  "./node_modules/bedrock-agentcore/dist/src/tools/browser/live-view/",
  import.meta.url
));
const allowedFrames = process.env.HAPPY_FRONTEND_ORIGINS ?? "http://localhost:5173 http://localhost:3000";

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [{
        src: `${liveViewRoot}/nice-dcv-web-client-sdk/dcvjs-esm/**/*`,
        dest: "nice-dcv-web-client-sdk/dcvjs-esm"
      }]
    })
  ],
  resolve: {
    alias: {
      dcv: `${liveViewRoot}/nice-dcv-web-client-sdk/dcvjs-esm/dcv.js`,
      "dcv-ui": `${liveViewRoot}/nice-dcv-web-client-sdk/dcv-ui/dcv-ui.js`
    }
  },
  server: {
    port: 5173,
    headers: { "Content-Security-Policy": `frame-ancestors 'self' ${allowedFrames}` }
  },
  preview: {
    headers: { "Content-Security-Policy": `frame-ancestors 'self' ${allowedFrames}` }
  }
});
