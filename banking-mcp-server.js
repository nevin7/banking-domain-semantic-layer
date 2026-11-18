#!/usr/bin/env node
/**
 * banking-mcp-server.js
 * MCP server that exposes the Banking Domain Glossary from OpenMetadata.
 * Connect to Claude Desktop to ground LLM responses in governed definitions.
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const https = require("https");
const http = require("http");

// ── Config ────────────────────────────────────────────────────────────────────
const OM_BASE    = "http://localhost:8585";
const OM_EMAIL   = "admin@open-metadata.org";
const OM_PASSWORD = Buffer.from("admin").toString("base64");
const GLOSSARY_NAME = "Banking Domain Glossary";

// ── OpenMetadata client ───────────────────────────────────────────────────────
let cachedToken = null;

async function getToken() {
  if (cachedToken) return cachedToken;
  const data = JSON.stringify({ email: OM_EMAIL, password: OM_PASSWORD });
  const result = await httpPost(`${OM_BASE}/api/v1/users/login`, data);
  cachedToken = result.accessToken;
  return cachedToken;
}

function httpGet(url, token) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req = http.request({
      hostname: opts.hostname,
      port: opts.port || 80,
      path: opts.pathname + opts.search,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      }
    }, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({ raw: body }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req = http.request({
      hostname: opts.hostname,
      port: opts.port || 80,
      path: opts.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      }
    }, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({ raw: body }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function getAllTerms(token) {
  let allTerms = [];
  let after = null;
  while (true) {
    const cursor = after ? `&after=${encodeURIComponent(after)}` : "";
    const url = `${OM_BASE}/api/v1/glossaryTerms?limit=50${cursor}`;
    const result = await httpGet(url, token);
    const terms = result?.data || [];
    allTerms = allTerms.concat(terms);
    after = result?.paging?.after;
    if (!after) break;
  }
  return allTerms;
}

async function searchGlossaryTerms(query) {
  const token = await getToken();
  const allTerms = await getAllTerms(token);
  const q = query.toLowerCase();
  const matches = allTerms.filter(t => {
    const name = (t.displayName || t.name || "").toLowerCase();
    const desc = (t.description || "").toLowerCase();
    return name.includes(q) || desc.includes(q);
  }).slice(0, 5);
  return matches.map(t => ({
    name: t.displayName || t.name,
    description: t.description,
    fullyQualifiedName: t.fullyQualifiedName,
    synonyms: t.synonyms || [],
  }));
}

async function getGlossaryTerm(termName) {
  const token = await getToken();
  const allTerms = await getAllTerms(token);
  const q = termName.toLowerCase();

  // Find best match by display name or name
  const match = allTerms.find(t =>
    (t.displayName || "").toLowerCase() === q ||
    (t.name || "").toLowerCase() === q.replace(/\s+/g, "_")
  ) || allTerms.find(t =>
    (t.displayName || "").toLowerCase().includes(q) ||
    (t.name || "").toLowerCase().includes(q.replace(/\s+/g, "_"))
  );

  if (!match) return null;

  // Fetch full detail with extension fields
  const fqn = match.fullyQualifiedName;
  const detail = await httpGet(
    `${OM_BASE}/api/v1/glossaryTerms/name/${encodeURIComponent(fqn)}?fields=extension,relatedTerms,synonyms,references`,
    token);

  return {
    name: detail.displayName || detail.name,
    description: detail.description,
    synonyms: detail.synonyms || [],
    relatedTerms: (detail.relatedTerms || []).map(r => r.displayName || r.name),
    references: (detail.references || []).map(r => r.name),
    fiboAlignment: detail.extension?.fiboAlignment,
    aiCanonicalDefinition: detail.extension?.aiCanonicalDefinition,
    scopeNote: detail.extension?.scopeNote,
    usageConstraints: detail.extension?.usageConstraints,
    fullyQualifiedName: fqn,
  };
}

async function listGlossaryDomains() {
  const token = await getToken();
  let allTerms = [];
  let after = null;

  while (true) {
    const cursor = after ? `&after=${encodeURIComponent(after)}` : "";
    const url = `${OM_BASE}/api/v1/glossaryTerms?limit=50${cursor}`;
    const result = await httpGet(url, token);
    const terms = result?.data || [];
    allTerms = allTerms.concat(terms);
    after = result?.paging?.after;
    if (!after) break;
  }

  return allTerms
    .filter(t => !t.parent)
    .map(t => ({
      name: t.displayName || t.name,
      description: t.description,
      fullyQualifiedName: t.fullyQualifiedName,
    }));
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "banking-semantics", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_banking_term",
      description: "Look up the authoritative definition of a banking term from the governed enterprise glossary. Returns the canonical definition, FIBO alignment, scope notes, usage constraints, synonyms, and related terms.",
      inputSchema: {
        type: "object",
        properties: {
          term: {
            type: "string",
            description: "The banking term to look up, e.g. 'Credit Risk Score', 'KYC', 'Loan Account'",
          }
        },
        required: ["term"],
      },
    },
    {
      name: "search_banking_terms",
      description: "Search the banking domain glossary for terms matching a keyword or concept.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query, e.g. 'risk', 'customer', 'AML'",
          }
        },
        required: ["query"],
      },
    },
    {
      name: "list_banking_domains",
      description: "List the top-level domains in the banking glossary (e.g. Customers & Parties, Credit & Risk, Regulatory Compliance).",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "get_banking_term") {
      const term = await getGlossaryTerm(args.term);
      if (!term) {
        return { content: [{ type: "text", text: `Term "${args.term}" not found in the banking glossary.` }] };
      }
      let text = `**${term.name}**\n\n`;
      if (term.aiCanonicalDefinition) text += `**AI Canonical Definition:** ${term.aiCanonicalDefinition}\n\n`;
      if (term.description) text += `**Definition:** ${term.description}\n\n`;
      if (term.scopeNote) text += `**Scope Note:** ${term.scopeNote}\n\n`;
      if (term.usageConstraints) text += `**Usage Constraints:** ${term.usageConstraints}\n\n`;
      if (term.fiboAlignment) text += `**FIBO Alignment:** ${term.fiboAlignment}\n\n`;
      if (term.synonyms?.length) text += `**Synonyms:** ${term.synonyms.join(", ")}\n\n`;
      if (term.relatedTerms?.length) text += `**Related Terms:** ${term.relatedTerms.join(", ")}\n\n`;
      text += `**Source:** Banking Domain Glossary (OpenMetadata) — ${term.fullyQualifiedName}`;
      return { content: [{ type: "text", text }] };
    }

    if (name === "search_banking_terms") {
      const results = await searchGlossaryTerms(args.query);
      if (!results.length) {
        return { content: [{ type: "text", text: `No terms found matching "${args.query}".` }] };
      }
      let text = `**Search results for "${args.query}":**\n\n`;
      results.forEach(r => {
        text += `• **${r.name}** — ${r.description?.substring(0, 120) || "No description"}...\n`;
      });
      return { content: [{ type: "text", text }] };
    }

    if (name === "list_banking_domains") {
      const domains = await listGlossaryDomains();
      let text = `**Banking Glossary Domains:**\n\n`;
      domains.forEach(d => {
        text += `• **${d.name}** — ${d.description?.substring(0, 100) || ""}...\n`;
      });
      return { content: [{ type: "text", text }] };
    }

    return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };

  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }] };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("Banking Semantics MCP server running\n");
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
