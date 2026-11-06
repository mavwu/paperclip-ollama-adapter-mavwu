// Keep native Node requests and agent selection. Intercept the final socket
// constructors before any DNS lookup, TLS handshake or network connection.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { createServiceClients } from "../../dist/server/http.js";
import { readOllamaConfig } from "../../dist/server/config.js";

const attempts = [], requests = [];
const capturedCreateConnection = net.createConnection;
function interceptSocket(kind, options) {
  const target = Array.isArray(options) ? options[0] : options;
  attempts.push({ kind, host: target.host ?? target.hostname, port: Number(target.port), verifyTLS: target.rejectUnauthorized });
  throw new Error("Test intercepted socket creation");
}
// Some supported Node versions retain a reference to net.createConnection in
// Agent.prototype. Intercept Socket.connect too, before it can start DNS/I/O.
net.Socket.prototype.connect = function (options) { return interceptSocket("tcp", options); };
for (const [module, kind] of [[net, "tcp"], [tls, "tls"]]) {
  const block = options => interceptSocket(kind, options);
  module.connect = block;
  if (kind === "tcp") module.createConnection = block;
}
try { capturedCreateConnection({ host: "socket-guard.invalid", port: 1 }); throw new Error("Socket interception was bypassed"); }
catch (error) { if (!error.message.includes("Test intercepted socket creation")) throw error; }
const guardAttempts = attempts.splice(0);
const socketGuardActive = guardAttempts.length === 1 && guardAttempts[0].host === "socket-guard.invalid";
// Positive control proves the requested proxy feature was actually activated.
try { http.request("http://localhost:11434/v1").end(); throw new Error("Socket interception was bypassed"); }
catch (error) { if (!error.message.includes("Test intercepted socket creation")) throw error; }
const controlAttempts = attempts.splice(0);
const proxyControl = { active: controlAttempts.length === 1 && controlAttempts[0].host === "review-proxy.invalid", attempts: controlAttempts };
for (const module of [http, https]) {
  const original = module.request;
  module.request = (options, callback) => {
    requests.push({ authorization: options.headers.Authorization ?? options.headers.authorization, ownAgent: options.agent !== module.globalAgent && Boolean(options.agent), proxyEnv: Boolean(options.agent?.options.proxyEnv) });
    return original(options, callback);
  };
}
for (const [model, paperclip] of [["http://localhost:11434/v1", "http://127.0.0.1:3100"], ["https://model.invalid/v1", "https://paperclip.invalid"]]) {
  const clients = createServiceClients(readOllamaConfig({ BASE_URL: model, PAPERCLIP_BASE_URL: paperclip, API_KEY: "model-secret" }), "run-secret");
  for (const request of [() => clients.complete({ messages: [] }), () => clients.listAgents("company")]) {
    try { await request(); throw new Error("Socket interception was bypassed"); }
    catch (error) { if (!error.message.includes("Test intercepted socket creation")) throw error; }
  }
}
process.stdout.write(JSON.stringify({ attempts, requests, proxyControl, socketGuardActive }));
