#!/usr/bin/env node

/**
 * Banking Ontology — GraphDB MCP Server
 * 
 * An MCP server that queries a GraphDB SPARQL endpoint to answer
 * competency questions via OWL 2 RL inference. Designed to run
 * alongside the existing banking-semantics MCP server (flat glossary
 * lookup via OpenMetadata) to demonstrate the contrast between
 * asserted-fact retrieval and ontology-driven reasoning.
 *
 * Tools exposed:
 *   get_regulatory_scope    — CQ1: property chain inference
 *   get_secured_borrowers   — CQ2: general class axiom inference
 *   get_nonperforming_loans — CQ4: category-based classification
 *   query_banking_ontology  — freeform SPARQL against the repo
 *
 * Requires: GraphDB running at GRAPHDB_URL (default http://localhost:7200)
 *           with repository GRAPHDB_REPO (default "banking-ontology")
 *           and OWL2-RL ruleset enabled.
 */

const http = require("http");
const https = require("https");
const readline = require("readline");

// ── Config ──────────────────────────────────────────────────────────────
const GRAPHDB_URL = process.env.GRAPHDB_URL || "http://localhost:7200";
const GRAPHDB_REPO = process.env.GRAPHDB_REPO || "banking-ontology";
const SPARQL_ENDPOINT = `${GRAPHDB_URL}/repositories/${GRAPHDB_REPO}`;
const PREFIX = "https://ontology.example.org/banking#";

// ── SPARQL helpers ──────────────────────────────────────────────────────

function sparqlQuery(query, includeInferred = true) {
  return new Promise((resolve, reject) => {
    const url = new URL(SPARQL_ENDPOINT);
    url.searchParams.set("query", query);
    url.searchParams.set("infer", String(includeInferred));

    const client = url.protocol === "https:" ? https : http;
    const req = client.get(url.toString(), {
      headers: { "Accept": "application/sparql-results+json" }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`GraphDB returned ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
  });
}

function shorten(uri) {
  if (typeof uri === "string" && uri.startsWith(PREFIX)) {
    return uri.substring(PREFIX.length);
  }
  return uri;
}

function formatResults(sparqlJson) {
  if (!sparqlJson.results || !sparqlJson.results.bindings) return [];
  return sparqlJson.results.bindings.map(row => {
    const obj = {};
    for (const [key, val] of Object.entries(row)) {
      obj[key] = val.type === "uri" ? shorten(val.value) : val.value;
    }
    return obj;
  });
}

// ── SPARQL queries ──────────────────────────────────────────────────────

const QUERIES = {
  regulatory_scope: (customer) => {
    const filter = customer
      ? `FILTER (CONTAINS(LCASE(?customerLabel), LCASE("${customer}")))`
      : "";
    return `
      PREFIX : <${PREFIX}>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT ?customer ?customerLabel ?framework ?frameworkLabel
      WHERE {
        ?customer :isSubjectTo ?framework .
        ?customer rdfs:label ?customerLabel .
        ?framework rdfs:label ?frameworkLabel .
        ${filter}
      }
      ORDER BY ?customerLabel ?frameworkLabel
    `;
  },

  secured_borrowers: () => `
    PREFIX : <${PREFIX}>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?customer ?customerLabel ?account ?accountLabel ?collateral ?collateralLabel
    WHERE {
      ?customer a :SecuredBorrower .
      ?customer rdfs:label ?customerLabel .
      OPTIONAL {
        ?customer :holdsAccount ?account .
        ?account :isSecuredBy ?collateral .
        ?account rdfs:label ?accountLabel .
        ?collateral rdfs:label ?collateralLabel .
      }
    }
    ORDER BY ?customerLabel
  `,

  nonperforming_loans: () => `
    PREFIX : <${PREFIX}>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?loan ?loanLabel ?balance ?daysDelq ?status ?holder ?holderLabel
    WHERE {
      ?loan a :NonPerformingLoan .
      ?loan rdfs:label ?loanLabel .
      OPTIONAL { ?loan :outstandingBalance ?balance }
      OPTIONAL { ?loan :daysDelinquent ?daysDelq }
      OPTIONAL { ?loan :hasPerformanceStatus ?statusInd . ?statusInd rdfs:label ?status }
      OPTIONAL {
        ?holder :holdsAccount ?loan .
        ?holder rdfs:label ?holderLabel .
      }
    }
    ORDER BY ?loanLabel
  `,
};

// ── MCP tool definitions ────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_regulatory_scope",
    description:
      "Returns regulatory frameworks (AML, KYC, CDD) that apply to each customer, " +
      "DERIVED by OWL inference from the property chain: customer → holdsAccount → " +
      "account → governedBy → framework. These relationships are never asserted " +
      "directly — they are entailed by the reasoner. Optionally filter by customer name.",
    inputSchema: {
      type: "object",
      properties: {
        customer: {
          type: "string",
          description: "Optional customer name to filter by (partial match). Leave empty for all customers."
        }
      }
    }
  },
  {
    name: "get_secured_borrowers",
    description:
      "Returns customers classified as SecuredBorrower by OWL inference. No customer " +
      "is asserted to be a SecuredBorrower — classification is derived from a general " +
      "class axiom: any Customer who holdsAccount SOME account that isSecuredBy SOME " +
      "Collateral. Also returns the securing account and collateral details.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "get_nonperforming_loans",
    description:
      "Returns loans classified as NonPerformingLoan by OWL inference. Classification " +
      "is derived from a category-based axiom: any LoanAccount with hasPerformanceStatus " +
      "VALUE Delinquent90Plus. The arithmetic (days delinquent → status bucket) happens " +
      "upstream; OWL classifies on the category. Returns balance, delinquency, and holder.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "query_banking_ontology",
    description:
      "Execute a custom SPARQL query against the banking ontology in GraphDB. " +
      "The default namespace is https://ontology.example.org/banking#. " +
      "Set includeInferred to false to see only explicitly asserted triples.",
    inputSchema: {
      type: "object",
      properties: {
        sparql: {
          type: "string",
          description: "The SPARQL SELECT query to execute."
        },
        includeInferred: {
          type: "boolean",
          description: "Whether to include inferred triples (default true).",
          default: true
        }
      },
      required: ["sparql"]
    }
  }
];

// ── MCP protocol (JSON-RPC over stdio) ──────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });
let buffer = "";

rl.on("line", (line) => {
  buffer += line;
  let msg;
  try {
    msg = JSON.parse(buffer);
    buffer = "";
  } catch {
    return; // incomplete JSON, wait for more
  }
  handleMessage(msg);
});

function send(response) {
  process.stdout.write(JSON.stringify(response) + "\n");
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "banking-graphdb",
          version: "1.0.0"
        }
      }
    });
    return;
  }

  if (method === "notifications/initialized") {
    return; // no response needed
  }

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "tools/call") {
    const toolName = params.name;
    const args = params.arguments || {};

    try {
      let results;

      switch (toolName) {
        case "get_regulatory_scope": {
          const raw = await sparqlQuery(QUERIES.regulatory_scope(args.customer || ""));
          results = formatResults(raw);
          if (results.length === 0) {
            send({
              jsonrpc: "2.0", id,
              result: {
                content: [{
                  type: "text",
                  text: args.customer
                    ? `No regulatory frameworks found for customer matching "${args.customer}". This property is derived by inference — if GraphDB's reasoner is not running or the property chain axiom is missing, no results will appear.`
                    : "No regulatory frameworks found. Verify that the OWL2-RL ruleset is enabled and the property chain axiom for :isSubjectTo is loaded."
                }]
              }
            });
            return;
          }

          // Group by customer
          const grouped = {};
          for (const r of results) {
            if (!grouped[r.customerLabel]) grouped[r.customerLabel] = [];
            grouped[r.customerLabel].push(r.frameworkLabel);
          }
          const lines = Object.entries(grouped)
            .map(([cust, fws]) => `${cust}: ${fws.join(", ")}`)
            .join("\n");

          send({
            jsonrpc: "2.0", id,
            result: {
              content: [{
                type: "text",
                text: `Regulatory frameworks by customer (derived by property chain inference: holdsAccount ∘ governedBy → isSubjectTo):\n\n${lines}\n\nThese relationships are NOT asserted in the data. They are entailed by the OWL 2 RL reasoner from the two-hop path customer → account → regulation.`
              }]
            }
          });
          break;
        }

        case "get_secured_borrowers": {
          const raw = await sparqlQuery(QUERIES.secured_borrowers());
          results = formatResults(raw);

          if (results.length === 0) {
            send({
              jsonrpc: "2.0", id,
              result: {
                content: [{
                  type: "text",
                  text: "No secured borrowers found. This classification is derived by a general class axiom — verify the OWL2-RL ruleset and that collateral is asserted on at least one account."
                }]
              }
            });
            return;
          }

          const grouped = {};
          for (const r of results) {
            if (!grouped[r.customerLabel]) grouped[r.customerLabel] = [];
            if (r.accountLabel && r.collateralLabel) {
              grouped[r.customerLabel].push(`${r.accountLabel} → ${r.collateralLabel}`);
            }
          }
          const lines = Object.entries(grouped)
            .map(([cust, details]) => `${cust}\n  ${details.join("\n  ")}`)
            .join("\n");

          send({
            jsonrpc: "2.0", id,
            result: {
              content: [{
                type: "text",
                text: `Secured Borrowers (derived by general class axiom: Customer ∩ ∃holdsAccount.(∃isSecuredBy.Collateral) ⊑ SecuredBorrower):\n\n${lines}\n\nNo customer is asserted as a SecuredBorrower. Classification is inferred from the account-collateral relationship.`
              }]
            }
          });
          break;
        }

        case "get_nonperforming_loans": {
          const raw = await sparqlQuery(QUERIES.nonperforming_loans());
          results = formatResults(raw);

          if (results.length === 0) {
            send({
              jsonrpc: "2.0", id,
              result: {
                content: [{
                  type: "text",
                  text: "No non-performing loans found. Classification requires hasPerformanceStatus = Delinquent90Plus on a LoanAccount."
                }]
              }
            });
            return;
          }

          const lines = results.map(r => {
            const parts = [r.loanLabel];
            if (r.balance) parts.push(`Balance: $${Number(r.balance).toLocaleString()}`);
            if (r.daysDelq) parts.push(`${r.daysDelq} days delinquent`);
            if (r.holderLabel) parts.push(`Held by: ${r.holderLabel}`);
            return parts.join(" | ");
          }).join("\n");

          send({
            jsonrpc: "2.0", id,
            result: {
              content: [{
                type: "text",
                text: `Non-Performing Loans (derived by category-based classification: LoanAccount ∩ ∃hasPerformanceStatus.{Delinquent90Plus} ⊑ NonPerformingLoan):\n\n${lines}\n\nClassification is inferred from the performance status category, not from the raw days-delinquent number. The arithmetic (days → bucket) happens upstream; OWL classifies on the category.`
              }]
            }
          });
          break;
        }

        case "query_banking_ontology": {
          const infer = args.includeInferred !== false;
          const raw = await sparqlQuery(args.sparql, infer);
          results = formatResults(raw);
          send({
            jsonrpc: "2.0", id,
            result: {
              content: [{
                type: "text",
                text: `Query returned ${results.length} result(s) (includeInferred=${infer}):\n\n${JSON.stringify(results, null, 2)}`
              }]
            }
          });
          break;
        }

        default:
          send({
            jsonrpc: "2.0", id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` }
          });
      }
    } catch (err) {
      send({
        jsonrpc: "2.0", id,
        result: {
          content: [{
            type: "text",
            text: `Error querying GraphDB: ${err.message}\n\nMake sure GraphDB is running at ${GRAPHDB_URL} with repository "${GRAPHDB_REPO}" and OWL2-RL ruleset.`
          }],
          isError: true
        }
      });
    }
    return;
  }

  // Unknown method
  if (id !== undefined) {
    send({
      jsonrpc: "2.0", id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  }
}
