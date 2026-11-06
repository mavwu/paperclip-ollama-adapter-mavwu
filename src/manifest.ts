import { agentConfigurationDoc, label, models, type } from "./metadata.js";

// Legacy metadata export retained for existing importers. This is not a current
// Paperclip general-plugin manifest; external adapters load the root factory.
export const manifest = {
  name: "paperclip-ollama-adapter-mavwu",
  label,
  version: "2.0.0",
  description: "One-shot Paperclip external adapter for Ollama text inference",
  adapters: [
    {
      type,
      label,
      module: "./index.js",
      exportName: "createServerAdapter",
      models,
      agentConfigurationDoc,
    },
  ],
};

export default manifest;
