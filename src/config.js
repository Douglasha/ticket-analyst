import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BASE_DIR = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(BASE_DIR, "data");
export const STATIC_DIR = path.join(BASE_DIR, "static");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
export const CACHE_FILE = path.join(DATA_DIR, "analyses_cache.json");
export const PLAYBOOKS_FILE = path.join(DATA_DIR, "playbooks.json");
export const RESOLVED_HISTORY_FILE = path.join(DATA_DIR, "resolved_history.json");
export const LEARNED_FEEDBACK_FILE = path.join(DATA_DIR, "learned_feedback.json");

dotenv.config({ path: path.join(BASE_DIR, ".env") });

export const DEFAULT_ORG_CONTEXT =
  "Setor de T.I. corporativo da Unimed. Atendemos Service Desk (Windows, impressoras, Office, rede), " +
  "Gestão de Acessos (Active Directory, VPN, pastas de rede, e-mail) e Sistemas Internos / ERP. " +
  "Sempre que precisar solicitar acesso remoto ao computador do usuário, peça o ID do HopToDesk. " +
  "Mantenha tom cordial, claro e objetivo com o usuário final, evitando jargões excessivos na resposta pública.";

export function loadSettings() {
  const defaults = {
    glpi_demo_mode: (process.env.GLPI_DEMO_MODE || "true").toLowerCase() === "true",
    glpi_api_url: process.env.GLPI_API_URL || "https://glpi.suaempresa.com.br/apirest.php",
    glpi_app_token: process.env.GLPI_APP_TOKEN || "",
    glpi_user_token: process.env.GLPI_USER_TOKEN || "",
    glpi_default_group: process.env.GLPI_DEFAULT_GROUP || "Todos",
    glpi_verify_ssl: (process.env.GLPI_VERIFY_SSL || "true").toLowerCase() === "true",
    ai_provider: process.env.AI_PROVIDER || "gemini",
    gemini_api_key: process.env.GEMINI_API_KEY || "",
    gemini_model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    openai_api_key: process.env.OPENAI_API_KEY || "",
    openai_model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    openai_base_url: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    ollama_base_url: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    ollama_model: process.env.OLLAMA_MODEL || "qwen2.5:3b",
    org_context: DEFAULT_ORG_CONTEXT,
    auth_local_user: process.env.AUTH_LOCAL_USER || "admin",
    auth_local_password: process.env.AUTH_LOCAL_PASSWORD || "admin123",
    auth_secret: process.env.AUTH_SECRET || "ticket-analyst-unimed-secret-key-2026",
  };

  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      return { ...defaults, ...saved };
    } catch {
      return defaults;
    }
  }
  return defaults;
}

export function saveSettings(newSettings) {
  const merged = { ...loadSettings(), ...newSettings };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

export function loadAnalysesCache() {
  if (!fs.existsSync(CACHE_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveAnalysisToCache(analysis) {
  const cache = loadAnalysesCache();
  cache[String(analysis.ticket_id)] = analysis;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

export function loadResolvedHistoryCache() {
  if (!fs.existsSync(RESOLVED_HISTORY_FILE)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(RESOLVED_HISTORY_FILE, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveResolvedHistoryCache(items) {
  if (!Array.isArray(items)) return [];
  fs.writeFileSync(RESOLVED_HISTORY_FILE, JSON.stringify(items, null, 2), "utf-8");
  return items;
}

export function loadLearnedFeedback() {
  if (!fs.existsSync(LEARNED_FEEDBACK_FILE)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(LEARNED_FEEDBACK_FILE, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveLearnedFeedbackEntry(entry) {
  const list = loadLearnedFeedback();
  const idx = list.findIndex((item) => String(item.ticket_id) === String(entry.ticket_id));
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...entry, updated_at: new Date().toISOString() };
  } else {
    list.unshift({ ...entry, created_at: new Date().toISOString() });
  }
  fs.writeFileSync(LEARNED_FEEDBACK_FILE, JSON.stringify(list.slice(0, 300), null, 2), "utf-8");
  return list;
}


