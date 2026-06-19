import { agentConfigurationDoc, label, models, type } from "./metadata.js";

export const manifest = {
  name: "paperclip-ollama-adapter-mavwu",
  label,
  version: "1.0.4",
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
