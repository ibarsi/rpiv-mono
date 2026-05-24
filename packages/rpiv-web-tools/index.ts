/**
 * rpiv-pi web-tools extension
 *
 * Provides `web_search` and `web_fetch` tools backed by a SearXNG instance.
 *
 * SearXNG base URL resolution precedence (first wins):
 *   1. SEARXNG_BASE_URL environment variable
 *   2. searxngBaseUrl field in ~/.config/rpiv-web-tools/config.json
 *
 * Use the /web-search-config slash command to set the base URL interactively.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Config file persistence
// ---------------------------------------------------------------------------

interface WebToolsConfig {
	searxngBaseUrl?: string;
}

const CONFIG_PATH = join(homedir(), ".config", "rpiv-web-tools", "config.json");
const DEFAULT_SEARXNG_BASE_URL = "http://192.168.0.39:8888";

function loadConfig(): WebToolsConfig {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as WebToolsConfig;
	} catch {
		return {};
	}
}

function saveConfig(config: WebToolsConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	try {
		chmodSync(CONFIG_PATH, 0o600);
	} catch {
		// chmod may fail on some filesystems — best effort only
	}
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function validateSearxngBaseUrl(value: string): string {
	const normalized = normalizeBaseUrl(value);
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new Error(`Invalid SearXNG base URL: ${value}`);
	}
	if (!["http:", "https:"].includes(parsed.protocol)) {
		throw new Error(`Unsupported SearXNG URL protocol: ${parsed.protocol}. Only http and https are supported.`);
	}
	return normalized;
}

function resolveSearxngBaseUrl(): string | undefined {
	const envUrl = process.env.SEARXNG_BASE_URL;
	if (envUrl?.trim()) return validateSearxngBaseUrl(envUrl);
	const config = loadConfig();
	if (config.searxngBaseUrl?.trim()) return validateSearxngBaseUrl(config.searxngBaseUrl);
	return undefined;
}

// ---------------------------------------------------------------------------
// SearXNG Search API client
// ---------------------------------------------------------------------------

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface SearchResponse {
	results: SearchResult[];
	query: string;
}

async function searchSearxng(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
	const baseUrl = resolveSearxngBaseUrl();
	if (!baseUrl) {
		throw new Error("SEARXNG_BASE_URL is not set. Run /web-search-config to configure, or export the env var.");
	}

	const url = new URL("/search", baseUrl);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("categories", "general");

	const res = await fetch(url.toString(), {
		method: "GET",
		headers: {
			Accept: "application/json",
			"User-Agent": "rpiv-web-tools/1.0",
		},
		signal,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`SearXNG API error (${res.status}): ${text}`);
	}

	const data = (await res.json()) as {
		results?: Array<{ title?: string; url?: string; content?: string }>;
	};
	const results: SearchResult[] = (data.results ?? [])
		.filter((r) => r.url)
		.slice(0, maxResults)
		.map((r) => ({
			title: r.title ?? "",
			url: r.url ?? "",
			snippet: r.content ?? "",
		}));

	return { results, query };
}

// ---------------------------------------------------------------------------
// HTML-to-text for web_fetch
// ---------------------------------------------------------------------------

function htmlToText(html: string): string {
	let text = html;
	text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
	text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
	text = text.replace(
		/<\/(p|div|h[1-6]|li|tr|br|blockquote|pre|section|article|header|footer|nav|details|summary)>/gi,
		"\n",
	);
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<[^>]+>/g, " ");
	text = text.replace(/&amp;/g, "&");
	text = text.replace(/&lt;/g, "<");
	text = text.replace(/&gt;/g, ">");
	text = text.replace(/&quot;/g, '"');
	text = text.replace(/&#39;/g, "'");
	text = text.replace(/&nbsp;/g, " ");
	text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

function extractTitle(html: string): string | undefined {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (match) {
		return match[1].replace(/<[^>]+>/g, "").trim() || undefined;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// =========================================================================
	// web_search tool
	// =========================================================================

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for information via a configured SearXNG instance. Returns a list of results with titles, URLs, and snippets. Use when you need current information not in your training data.",
		promptSnippet: "Search the web for up-to-date information via SearXNG",
		promptGuidelines: [
			"Use web_search for information beyond your training data — recent events, current library versions, live API documentation.",
			'Use the current year from "Current date:" in your context when searching for recent information or documentation.',
			'After answering using search results, include a "Sources:" section listing relevant URLs as markdown hyperlinks: [Title](URL). Never skip this.',
			"If SEARXNG_BASE_URL is not set, ask the user to run /web-search-config before proceeding.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "The search query. Be specific and use natural language.",
			}),
			max_results: Type.Optional(
				Type.Number({
					description: "Maximum number of results to return (1-10). Default: 5.",
					default: 5,
					minimum: 1,
					maximum: 10,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const maxResults = Math.min(Math.max(params.max_results ?? 5, 1), 10);

			onUpdate?.({
				content: [{ type: "text", text: `Searching SearXNG for: "${params.query}"...` }],
				details: { query: params.query, backend: "searxng", resultCount: 0 },
			});

			const response = await searchSearxng(params.query, maxResults, signal);

			if (response.results.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No results found for "${params.query}".`,
						},
					],
					details: { query: params.query, backend: "searxng", resultCount: 0 },
				};
			}

			let text = `**Search results for "${response.query}":**\n\n`;
			for (let i = 0; i < response.results.length; i++) {
				const r = response.results[i];
				text += `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}\n\n`;
			}

			return {
				content: [{ type: "text", text: text.trimEnd() }],
				details: {
					query: params.query,
					backend: "searxng",
					resultCount: response.results.length,
					results: response.results,
				},
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("WebSearch "));
			text += theme.fg("accent", `"${args.query}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
			}
			const details = result.details as { resultCount?: number; results?: SearchResult[] };
			const count = details?.resultCount ?? 0;
			let text = theme.fg("success", `✓ ${count} result${count !== 1 ? "s" : ""}`);
			if (expanded && details?.results) {
				for (const r of details.results.slice(0, 5)) {
					text += `\n  ${theme.fg("dim", `• ${r.title}`)}`;
				}
				if (details.results.length > 5) {
					text += `\n  ${theme.fg("dim", `... and ${details.results.length - 5} more`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});

	// =========================================================================
	// web_fetch tool
	// =========================================================================

	interface FetchDetails {
		url: string;
		title?: string;
		contentType?: string;
		contentLength?: number;
		truncation?: TruncationResult;
		fullOutputPath?: string;
	}

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch the content of a specific URL. Returns text content for HTML pages (tags stripped), raw text for plain text or JSON. Supports http and https only. Content is truncated to avoid overwhelming the context window.",
		promptSnippet: "Fetch and read content from a specific URL",
		promptGuidelines: [
			"Use web_fetch to read the full content of a specific URL — documentation pages, blog posts, API references found via web_search.",
			"web_fetch is complementary to web_search: search finds URLs, fetch reads them.",
			'After answering using fetched content, include a "Sources:" section with a markdown hyperlink to the fetched URL.',
			"Large responses are truncated and spilled to a temp file — the temp path is reported in the result details.",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "The URL to fetch. Must be http or https.",
			}),
			raw: Type.Optional(
				Type.Boolean({
					description: "If true, return the raw HTML instead of extracted text. Default: false.",
					default: false,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const { url, raw = false } = params;

			let parsedUrl: URL;
			try {
				parsedUrl = new URL(url);
			} catch {
				throw new Error(`Invalid URL: ${url}`);
			}
			if (!["http:", "https:"].includes(parsedUrl.protocol)) {
				throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}. Only http and https are supported.`);
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching: ${url}...` }],
				details: { url } as FetchDetails,
			});

			const res = await fetch(url, {
				signal,
				redirect: "follow",
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; rpiv-pi/1.0)",
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
				},
			});

			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
			}

			const contentType = res.headers.get("content-type") ?? "";
			const contentLength = res.headers.get("content-length");

			if (contentType.includes("image/") || contentType.includes("video/") || contentType.includes("audio/")) {
				throw new Error(`Unsupported content type: ${contentType}. web_fetch supports text pages only.`);
			}

			const body = await res.text();

			let resultText: string;
			let title: string | undefined;

			if (contentType.includes("text/html") && !raw) {
				title = extractTitle(body);
				resultText = htmlToText(body);
			} else {
				resultText = body;
			}

			const truncation = truncateHead(resultText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: FetchDetails = {
				url,
				title,
				contentType,
				contentLength: contentLength ? Number(contentLength) : undefined,
			};

			let output = truncation.content;

			if (truncation.truncated) {
				const tempDir = await mkdtemp(join(tmpdir(), "rpiv-fetch-"));
				const tempFile = join(tempDir, "content.txt");
				await writeFile(tempFile, resultText, "utf8");
				details.truncation = truncation;
				details.fullOutputPath = tempFile;

				const truncatedLines = truncation.totalLines - truncation.outputLines;
				const truncatedBytes = truncation.totalBytes - truncation.outputBytes;
				output += `\n\n[Content truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				output += ` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.`;
				output += ` Full content saved to: ${tempFile}]`;
			}

			let header = `**Fetched:** ${url}`;
			if (title) header += `\n**Title:** ${title}`;
			if (contentType) header += `\n**Content-Type:** ${contentType}`;
			header += "\n\n";

			return {
				content: [{ type: "text", text: header + output }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("WebFetch "));
			text += theme.fg("accent", args.url);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}
			const details = result.details as FetchDetails | undefined;
			let text = theme.fg("success", "✓ Fetched");
			if (details?.title) {
				text += theme.fg("muted", `: ${details.title}`);
			}
			if (details?.truncation?.truncated) {
				text += theme.fg("warning", " (truncated)");
			}
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 15);
					for (const line of lines) {
						text += `\n  ${theme.fg("dim", line)}`;
					}
					if (content.text.split("\n").length > 15) {
						text += `\n  ${theme.fg("muted", "... (use read tool to see full content)")}`;
					}
				}
			}
			return new Text(text, 0, 0);
		},
	});

	// =========================================================================
	// /web-search-config slash command
	// =========================================================================

	pi.registerCommand("web-search-config", {
		description: "Configure the SearXNG base URL used by web_search",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui?.notify?.("/web-search-config requires interactive mode", "error");
				return;
			}

			const current = loadConfig();
			const showMode = typeof args === "string" && args.includes("--show");

			if (showMode) {
				const configUrl = current.searxngBaseUrl ?? "(not set)";
				const envUrl = process.env.SEARXNG_BASE_URL ?? "(not set)";
				ctx.ui.notify(
					`Web search config:\n  config file: ${CONFIG_PATH}\n  searxngBaseUrl: ${configUrl}\n  SEARXNG_BASE_URL env: ${envUrl}`,
					"info",
				);
				return;
			}

			const input = await ctx.ui.input(
				"SearXNG base URL",
				current.searxngBaseUrl ? "(leave empty to keep existing)" : DEFAULT_SEARXNG_BASE_URL,
			);

			if (input === undefined || input === null) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}

			const trimmed = input.trim();
			if (!trimmed) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}

			let searxngBaseUrl: string;
			try {
				searxngBaseUrl = validateSearxngBaseUrl(trimmed);
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : "Invalid SearXNG base URL", "error");
				return;
			}

			saveConfig({ ...current, searxngBaseUrl });
			ctx.ui.notify(`Saved SearXNG base URL to ${CONFIG_PATH}`, "info");
		},
	});
}
