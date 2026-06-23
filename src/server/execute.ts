import axios, { AxiosError } from "axios";
import "dotenv/config";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import { label, type } from "../metadata.js";
import { readOllamaConfig, type PaperclipRuntimeSkill } from "./config.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

type JsonObject = Record<string, unknown>;
