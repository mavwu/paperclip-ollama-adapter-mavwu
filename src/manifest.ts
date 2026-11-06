import { agentConfigurationDoc, label, models, type } from "./metadata.js";

// Legacy metadata export retained for existing importers. This is not a current
// Paperclip general-plugin manifest; external adapters load the root factory.
export const manifest = {
  name: "paperclip-ollama-adapter-mavwu",
  label,
  version: "1.0.10",
  description: "Paperclip external adapter for Ollama and local LLMs",
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
